// ── Constants ──
const USD_TO_TWD = 31.5;
const BUDGET_TWD = 300000;
const TRIP_START = new Date(2026, 7, 25); // 月份從0開始，7=8月
const TOTAL_DAYS = 12;

const PAYERS = ["小芋", "媽媽", "珊珊"];
const PRICE_RANGES = ["$", "$$", "$$$"];

// Day labels: Day 1 = 8/25 ... Day 12 = 9/5
function getDayDate(day) {
  const d = new Date(TRIP_START);
  d.setDate(d.getDate() + day - 1);
  return d;
}
function formatDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

// ── Parse lat/lng from Google Maps URL ──
function parseLatLng(url) {
  if (!url) return null;
  const m = url.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  const m2 = url.match(/q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
  return null;
}

// ── Geocode place name via Nominatim ──
async function geocodeByName(name) {
  try {
    const q = encodeURIComponent(name + ", Los Angeles, CA");
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
      headers: { "Accept-Language": "en" }
    });
    const data = await res.json();
    if (data.length > 0) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch(e) {}
  return null;
}

// ── Wait for Firebase to be ready ──
function waitForDB() {
  return new Promise(resolve => {
    const check = () => {
      if (window.__db && window.__fs && window.__checklist) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

async function initApp() {
  await waitForDB();
  lucide.createIcons();

  setupNav();
  initChecklist();
  initItinerary();
  initRestaurant();
  initMap();
  initExpense();
  setupModal();
}

window.initApp = initApp;

// ── Navigation ──
function setupNav() {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`page-${page}`).classList.add("active");
      if (page === "map") refreshMap();
    });
  });
}

// ── Modal ──
let modalResolve = null;

function setupModal() {
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-overlay").addEventListener("click", e => {
    if (e.target === document.getElementById("modal-overlay")) closeModal();
  });
  document.getElementById("add-to-day-close").addEventListener("click", () => {
    document.getElementById("add-to-day-overlay").classList.add("hidden");
  });
}

function openModal(title, bodyHTML) {
  return new Promise(resolve => {
    modalResolve = resolve;
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-body").innerHTML = bodyHTML;
    document.getElementById("modal-overlay").classList.remove("hidden");
    lucide.createIcons();
  });
}

function closeModal(result = null) {
  document.getElementById("modal-overlay").classList.add("hidden");
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}

// ── Form helpers ──
function formVal(id) { return document.getElementById(id)?.value.trim() ?? ""; }
function formCheck(id) { return document.getElementById(id)?.checked ?? false; }

// ════════════════════════════════════════
// 行前準備
// ════════════════════════════════════════
function initChecklist() {
  const { collection, onSnapshot, doc, setDoc } = window.__fs;
  const db = window.__db;
  const items = window.__checklist;

  const checksRef = collection(db, "checklist_checks");

  onSnapshot(checksRef, snapshot => {
    const checks = {};
    snapshot.forEach(d => { checks[d.id] = d.data().checked; });
    renderChecklist(items, checks);
  });

  function renderChecklist(items, checks) {
    const yiyu = items.filter(i => i.owner === "yiyu");
    const family = items.filter(i => i.owner === "family");

    renderList("checklist-yiyu", yiyu, checks);
    renderList("checklist-family", family, checks);

    const yiyuDone = yiyu.filter(i => checks[i.id]).length;
    const familyDone = family.filter(i => checks[i.id]).length;
    const total = items.length;
    const done = yiyuDone + familyDone;

    document.getElementById("overall-progress-text").textContent = `${done} / ${total}`;
    document.getElementById("overall-progress-fill").style.width = `${total > 0 ? (done / total) * 100 : 0}%`;

    document.getElementById("yiyu-progress-text").textContent = `${yiyuDone} / ${yiyu.length}`;
    document.getElementById("yiyu-progress-fill").style.width = `${yiyu.length > 0 ? (yiyuDone / yiyu.length) * 100 : 0}%`;

    document.getElementById("family-progress-text").textContent = `${familyDone} / ${family.length}`;
    document.getElementById("family-progress-fill").style.width = `${family.length > 0 ? (familyDone / family.length) * 100 : 0}%`;
  }

  function renderList(elId, items, checks) {
    const ul = document.getElementById(elId);
    ul.innerHTML = items.map(item => `
      <li class="${checks[item.id] ? 'checked' : ''}" data-id="${item.id}">
        <span class="check-box"><i data-lucide="check"></i></span>
        <span class="item-text">${item.text}</span>
      </li>
    `).join("");
    lucide.createIcons();

    ul.querySelectorAll("li").forEach(li => {
      li.addEventListener("click", async () => {
        const id = li.dataset.id;
        const current = li.classList.contains("checked");
        await setDoc(doc(db, "checklist_checks", id), { checked: !current });
      });
    });
  }
}

// ════════════════════════════════════════
// 行程
// ════════════════════════════════════════
let currentDay = 1;
let itineraryData = [];
let itinerarySortable = null;

function initItinerary() {
  buildDaySelector();
  document.getElementById("btn-add-itinerary").addEventListener("click", () => openItineraryForm());

  const { collection, onSnapshot, orderBy, query } = window.__fs;
  const db = window.__db;

  onSnapshot(collection(db, "itinerary"), snapshot => {
    itineraryData = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderItinerary();
    if (mapInitialized) refreshMap();
  });
}

function buildDaySelector() {
  const sel = document.getElementById("day-selector");
  sel.innerHTML = "";
  for (let d = 1; d <= TOTAL_DAYS; d++) {
    const dt = getDayDate(d);
    const btn = document.createElement("button");
    btn.className = "day-chip" + (d === currentDay ? " active" : "");
    btn.innerHTML = `<span class="day-num">${d}</span><span>${formatDate(dt)}</span>`;
    btn.addEventListener("click", () => {
      currentDay = d;
      document.querySelectorAll(".day-chip").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      renderItinerary();
    });
    sel.appendChild(btn);
  }
}

function renderItinerary() {
  const list = document.getElementById("itinerary-list");
  const dayItems = itineraryData
    .filter(i => i.day === currentDay)
    .sort((a, b) => a.order - b.order);

  if (dayItems.length === 0) {
    list.innerHTML = `<div class="empty-state"><i data-lucide="map-pin"></i><p>還沒有行程，點右下角 + 新增</p></div>`;
    lucide.createIcons();
    return;
  }

  list.innerHTML = dayItems.map(item => `
    <div class="swipe-row" data-id="${item.id}">
      <div class="swipe-actions">
        <button class="swipe-btn swipe-move btn-move-day" data-id="${item.id}"><i data-lucide="calendar-arrow-up"></i>移天</button>
        <button class="swipe-btn swipe-delete btn-del-itinerary" data-id="${item.id}"><i data-lucide="trash-2"></i>刪除</button>
      </div>
      <div class="card" data-id="${item.id}">
        <div class="drag-handle"><i data-lucide="grip-vertical"></i></div>
        <div class="card-title">${item.name}</div>
        <div class="card-meta">
          ${item.hasReservation ? `<span class="tag green">預約 ${item.reservationTime || ''}</span>` : ''}
        </div>
        ${item.notes ? `<div class="card-note">${item.notes}</div>` : ''}
        <div class="card-actions">
          ${item.mapsUrl ? `<a class="maps-btn" href="${item.mapsUrl}" target="_blank"><i data-lucide="map-pin"></i>Google Maps</a>` : ''}
          <button class="btn btn-ghost btn-edit-itinerary" data-id="${item.id}"><i data-lucide="pencil"></i>編輯</button>
        </div>
      </div>
    </div>
  `).join("");
  lucide.createIcons();
  setupSwipeRows(list);

  list.querySelectorAll(".btn-edit-itinerary").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = itineraryData.find(i => i.id === btn.dataset.id);
      if (item) openItineraryForm(item);
    });
  });
  list.querySelectorAll(".btn-del-itinerary").forEach(btn => {
    btn.addEventListener("click", () => deleteItinerary(btn.dataset.id));
  });
  list.querySelectorAll(".btn-move-day").forEach(btn => {
    btn.addEventListener("click", () => openMoveToDayPicker(btn.dataset.id));
  });

  if (itinerarySortable) itinerarySortable.destroy();
  itinerarySortable = Sortable.create(list, {
    animation: 150,
    handle: ".drag-handle",
    ghostClass: "sortable-ghost",
    onEnd: saveItineraryOrder
  });
}

function setupSwipeRows(container, cardSelector = ".card") {
  container.querySelectorAll(".swipe-row").forEach(row => {
    const card = row.querySelector(cardSelector);
    const actions = row.querySelector(".swipe-actions");
    let startX = 0, currentX = 0, swiping = false;
    const THRESHOLD = 80;

    card.addEventListener("touchstart", e => {
      startX = e.touches[0].clientX;
      swiping = true;
    }, { passive: true });

    card.addEventListener("touchmove", e => {
      if (!swiping) return;
      currentX = e.touches[0].clientX - startX;
      if (currentX < 0) {
        card.style.transform = `translateX(${Math.max(currentX, -160)}px)`;
        card.style.transition = "none";
      }
    }, { passive: true });

    card.addEventListener("touchend", () => {
      swiping = false;
      card.style.transition = "transform 0.25s ease";
      if (currentX < -THRESHOLD) {
        card.style.transform = "translateX(-160px)";
        row.classList.add("open");
      } else {
        card.style.transform = "translateX(0)";
        row.classList.remove("open");
      }
      currentX = 0;
    });
  });

  // 點卡片以外的地方收回
  document.addEventListener("touchstart", e => {
    if (!e.target.closest(".swipe-row")) {
      container.querySelectorAll(".swipe-row.open").forEach(row => {
        row.querySelector(".card").style.transform = "translateX(0)";
        row.classList.remove("open");
      });
    }
  }, { passive: true });
}

function openMoveToDayPicker(itemId) {
  const item = itineraryData.find(i => i.id === itemId);
  if (!item) return;
  document.getElementById("add-to-day-name").textContent = `「${item.name}」移到哪一天？`;
  const picker = document.getElementById("day-picker");
  picker.innerHTML = "";
  for (let d = 1; d <= TOTAL_DAYS; d++) {
    if (d === item.day) continue;
    const dt = getDayDate(d);
    const btn = document.createElement("button");
    btn.className = "day-pick-btn";
    btn.innerHTML = `Day ${d}<br><small>${formatDate(dt)}</small>`;
    btn.addEventListener("click", async () => {
      document.getElementById("add-to-day-overlay").classList.add("hidden");
      const { doc, updateDoc } = window.__fs;
      try {
        await updateDoc(doc(window.__db, "itinerary", itemId), {
          day: d,
          date: dateStr(getDayDate(d)),
          order: itineraryData.filter(i => i.day === d).length
        });
      } catch(e) { alert("移動失敗：" + e.message); }
    });
    picker.appendChild(btn);
  }
  document.getElementById("add-to-day-overlay").classList.remove("hidden");
}

async function saveItineraryOrder(evt) {
  const { doc, updateDoc } = window.__fs;
  const db = window.__db;
  const cards = document.querySelectorAll("#itinerary-list .card");
  const updates = [];
  cards.forEach((card, idx) => {
    updates.push(updateDoc(doc(db, "itinerary", card.dataset.id), { order: idx }));
  });
  await Promise.all(updates);
}

function itineraryFormHTML(item = {}) {
  return `
    <div class="form-group">
      <label>地點名稱 *</label>
      <input id="f-name" value="${item.name || ''}" placeholder="例：Universal Studios" />
    </div>
    <div class="form-group">
      <label>Google Maps URL <span style="font-size:11px;color:#aaa;">（貼完整網址，非縮短連結）</span></label>
      <input id="f-maps" value="${item.mapsUrl || ''}" placeholder="貼上 Google Maps 連結" />
    </div>
    <div class="form-toggle">
      <span>有預約</span>
      <button class="toggle-switch ${item.hasReservation ? 'on' : ''}" id="f-reservation-toggle"></button>
    </div>
    <div class="form-group" id="f-res-time-wrap" style="display:${item.hasReservation ? 'flex' : 'none'}">
      <label>預約時間</label>
      <input id="f-res-time" value="${item.reservationTime || ''}" placeholder="例：10:30 AM" />
    </div>
    <div class="form-group">
      <label>備註</label>
      <textarea id="f-notes" placeholder="需要攜帶的東西、注意事項...">${item.notes || ''}</textarea>
    </div>
    <div class="form-actions">
      <button class="btn btn-ghost" id="f-cancel">取消</button>
      <button class="btn btn-primary" id="f-save">儲存</button>
    </div>
  `;
}

async function openItineraryForm(item = null) {
  const title = item ? "編輯行程" : "新增行程";
  openModal(title, itineraryFormHTML(item || {}));

  const toggle = document.getElementById("f-reservation-toggle");
  toggle.addEventListener("click", () => {
    toggle.classList.toggle("on");
    const wrap = document.getElementById("f-res-time-wrap");
    wrap.style.display = toggle.classList.contains("on") ? "flex" : "none";
  });

  document.getElementById("f-cancel").addEventListener("click", () => closeModal());
  document.getElementById("f-save").addEventListener("click", async () => {
    const name = formVal("f-name");
    if (!name) { alert("請填寫地點名稱"); return; }
    const mapsUrl = formVal("f-maps");
    const coords = parseLatLng(mapsUrl);
    const hasReservation = document.getElementById("f-reservation-toggle").classList.contains("on");

    const data = {
      day: currentDay,
      date: dateStr(getDayDate(currentDay)),
      name,
      mapsUrl: mapsUrl || null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      hasReservation,
      reservationTime: hasReservation ? formVal("f-res-time") : null,
      notes: formVal("f-notes") || null,
      order: item?.order ?? itineraryData.filter(i => i.day === currentDay).length
    };

    // 沒有座標時用名稱自動查詢
    if (!data.lat) {
      const geo = await geocodeByName(name);
      if (geo) { data.lat = geo.lat; data.lng = geo.lng; }
    }

    const { doc, setDoc, addDoc, collection, updateDoc } = window.__fs;
    const db = window.__db;
    try {
      if (item) {
        await updateDoc(doc(db, "itinerary", item.id), data);
      } else {
        await addDoc(collection(db, "itinerary"), data);
      }
      closeModal();
    } catch (e) {
      alert("儲存失敗：" + e.message);
    }
  });
}

async function deleteItinerary(id) {
  if (!confirm("確定要刪除這個行程？")) return;
  const { doc, deleteDoc } = window.__fs;
  await deleteDoc(doc(window.__db, "itinerary", id));
}

// ════════════════════════════════════════
// 餐廳
// ════════════════════════════════════════
let restaurantData = [];

function initRestaurant() {
  document.getElementById("btn-add-restaurant").addEventListener("click", () => openRestaurantForm());

  const { collection, onSnapshot, orderBy, query } = window.__fs;
  const db = window.__db;

  onSnapshot(collection(db, "restaurants"), snapshot => {
    restaurantData = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderRestaurants();
  });
}

function renderRestaurants() {
  const list = document.getElementById("restaurant-list");
  if (restaurantData.length === 0) {
    list.innerHTML = `<div class="empty-state"><i data-lucide="utensils"></i><p>還沒有餐廳，點右下角 + 新增</p></div>`;
    lucide.createIcons();
    return;
  }

  list.innerHTML = restaurantData.map(r => `
    <div class="swipe-row" data-id="${r.id}">
      <div class="swipe-actions">
        <button class="swipe-btn swipe-edit btn-edit-rest" data-id="${r.id}"><i data-lucide="pencil"></i>編輯</button>
        <button class="swipe-btn swipe-delete btn-del-rest" data-id="${r.id}"><i data-lucide="trash-2"></i>刪除</button>
      </div>
      <div class="card" data-id="${r.id}">
        <div class="card-title">${r.name}</div>
        <div class="card-meta">
          ${r.cuisine ? `<span class="tag">${r.cuisine}</span>` : ''}
          ${r.priceRange ? `<span class="tag blue">${r.priceRange}</span>` : ''}
        </div>
        ${r.notes ? `<div class="card-note">${r.notes}</div>` : ''}
        <div class="card-actions">
          ${r.mapsUrl ? `<a class="maps-btn" href="${r.mapsUrl}" target="_blank"><i data-lucide="map-pin"></i>Google Maps</a>` : ''}
          <button class="btn btn-yellow btn-add-to-day" data-id="${r.id}"><i data-lucide="calendar-plus"></i>加入行程</button>
        </div>
      </div>
    </div>
  `).join("");
  lucide.createIcons();
  setupSwipeRows(list);

  list.querySelectorAll(".btn-add-to-day").forEach(btn => {
    btn.addEventListener("click", () => openAddToDay(btn.dataset.id));
  });
  list.querySelectorAll(".btn-edit-rest").forEach(btn => {
    btn.addEventListener("click", () => {
      const r = restaurantData.find(x => x.id === btn.dataset.id);
      if (r) openRestaurantForm(r);
    });
  });
  list.querySelectorAll(".btn-del-rest").forEach(btn => {
    btn.addEventListener("click", () => deleteRestaurant(btn.dataset.id));
  });
}

function restaurantFormHTML(r = {}) {
  return `
    <div class="form-group">
      <label>餐廳名稱 *</label>
      <input id="r-name" value="${r.name || ''}" placeholder="例：In-N-Out Burger" />
    </div>
    <div class="form-group">
      <label>料理類型</label>
      <input id="r-cuisine" value="${r.cuisine || ''}" placeholder="例：美式漢堡、日式拉麵" />
    </div>
    <div class="form-group">
      <label>價位</label>
      <select id="r-price">
        <option value="">不填</option>
        ${PRICE_RANGES.map(p => `<option value="${p}" ${r.priceRange === p ? 'selected' : ''}>${p}</option>`).join("")}
      </select>
    </div>
    <div class="form-group">
      <label>Google Maps URL</label>
      <input id="r-maps" value="${r.mapsUrl || ''}" placeholder="貼上 Google Maps 連結" />
    </div>
    <div class="form-group">
      <label>備註</label>
      <textarea id="r-notes" placeholder="必點、注意事項...">${r.notes || ''}</textarea>
    </div>
    <div class="form-actions">
      <button class="btn btn-ghost" id="r-cancel">取消</button>
      <button class="btn btn-primary" id="r-save">儲存</button>
    </div>
  `;
}

async function openRestaurantForm(r = null) {
  openModal(r ? "編輯餐廳" : "新增餐廳", restaurantFormHTML(r || {}));
  document.getElementById("r-cancel").addEventListener("click", () => closeModal());
  document.getElementById("r-save").addEventListener("click", async () => {
    const name = formVal("r-name");
    if (!name) { alert("請填寫餐廳名稱"); return; }
    const mapsUrl = formVal("r-maps");
    const coords = parseLatLng(mapsUrl);

    const data = {
      name,
      cuisine: formVal("r-cuisine") || null,
      priceRange: formVal("r-price") || null,
      mapsUrl: mapsUrl || null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      notes: formVal("r-notes") || null,
    };

    if (!data.lat) {
      const geo = await geocodeByName(name);
      if (geo) { data.lat = geo.lat; data.lng = geo.lng; }
    }

    const { doc, addDoc, updateDoc, collection } = window.__fs;
    const db = window.__db;
    try {
      if (r) {
        await updateDoc(doc(db, "restaurants", r.id), data);
      } else {
        await addDoc(collection(db, "restaurants"), data);
      }
      closeModal();
    } catch(e) {
      alert("儲存失敗：" + e.message);
    }
  });
}

async function deleteRestaurant(id) {
  if (!confirm("確定要刪除這間餐廳？")) return;
  const { doc, deleteDoc } = window.__fs;
  await deleteDoc(doc(window.__db, "restaurants", id));
}

function openAddToDay(restaurantId) {
  const r = restaurantData.find(x => x.id === restaurantId);
  if (!r) return;

  document.getElementById("add-to-day-name").textContent = r.name;
  const picker = document.getElementById("day-picker");
  picker.innerHTML = "";

  for (let d = 1; d <= TOTAL_DAYS; d++) {
    const dt = getDayDate(d);
    const btn = document.createElement("button");
    btn.className = "day-pick-btn";
    btn.innerHTML = `Day ${d}<br><small>${formatDate(dt)}</small>`;
    btn.addEventListener("click", async () => {
      await addRestaurantToItinerary(r, d);
      document.getElementById("add-to-day-overlay").classList.add("hidden");
    });
    picker.appendChild(btn);
  }

  document.getElementById("add-to-day-overlay").classList.remove("hidden");
}

async function addRestaurantToItinerary(r, day) {
  const { addDoc, collection } = window.__fs;
  const db = window.__db;
  const dayItems = itineraryData.filter(i => i.day === day);
  await addDoc(collection(db, "itinerary"), {
    day,
    date: dateStr(getDayDate(day)),
    name: r.name,
    mapsUrl: r.mapsUrl || null,
    lat: r.lat || null,
    lng: r.lng || null,
    hasReservation: false,
    reservationTime: null,
    notes: r.notes || null,
    order: dayItems.length,
  });
}

// ════════════════════════════════════════
// 地圖
// ════════════════════════════════════════
let leafletMap = null;
let mapInitialized = false;

// 12 種不同顏色給 12 天
const DAY_COLORS = [
  "#6BAED6","#FDB462","#B3DE69","#FB8072","#80B1D3",
  "#BEBADA","#FFFFB3","#FCCDE5","#BC80BD","#CCEBC5",
  "#FFED6F","#8DD3C7"
];

function initMap() {}

function refreshMap() {
  if (!mapInitialized) {
    leafletMap = L.map("map", { zoomControl: true }).setView([34.05, -118.25], 10);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(leafletMap);
    mapInitialized = true;
  }

  // 清除舊標記
  leafletMap.eachLayer(layer => {
    if (layer instanceof L.Marker || layer instanceof L.Polyline) {
      leafletMap.removeLayer(layer);
    }
  });

  const bounds = [];

  for (let d = 1; d <= TOTAL_DAYS; d++) {
    const dayItems = itineraryData
      .filter(i => i.day === d && i.lat && i.lng)
      .sort((a, b) => a.order - b.order);

    const color = DAY_COLORS[d - 1];
    const latlngs = [];

    dayItems.forEach(item => {
      const ll = [item.lat, item.lng];
      latlngs.push(ll);
      bounds.push(ll);

      const marker = L.circleMarker(ll, {
        radius: 8,
        fillColor: color,
        color: "#fff",
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9,
      }).addTo(leafletMap);

      marker.bindPopup(`<b>Day ${d} · ${formatDate(getDayDate(d))}</b><br>${item.name}`);
    });

    if (latlngs.length > 1) {
      L.polyline(latlngs, { color, weight: 2.5, opacity: 0.7 }).addTo(leafletMap);
    }
  }

  if (bounds.length > 0) {
    leafletMap.fitBounds(bounds, { padding: [30, 30] });
    document.getElementById("map-hint")?.remove();
  } else {
    if (!document.getElementById("map-hint")) {
      const hint = document.createElement("div");
      hint.id = "map-hint";
      hint.className = "map-hint";
      hint.textContent = "在行程中填入完整 Google Maps 連結，地點就會出現在這裡";
      document.getElementById("page-map").appendChild(hint);
    }
  }

  setTimeout(() => leafletMap.invalidateSize(), 100);
}

// ════════════════════════════════════════
// 記帳
// ════════════════════════════════════════
let expenseData = [];
let activePayerFilter = null;

function initExpense() {
  document.getElementById("btn-add-expense").addEventListener("click", () => openExpenseForm());

  const { collection, onSnapshot, orderBy, query } = window.__fs;
  const db = window.__db;

  onSnapshot(collection(db, "expenses"), snapshot => {
    expenseData = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    expenseData.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : b.createdAt > a.createdAt ? 1 : -1));
    renderExpenses();
  });
}

function toTWD(amount, currency) {
  return currency === "USD" ? Math.round(amount * USD_TO_TWD) : Math.round(amount);
}

function renderExpenses() {
  const totalTWD = expenseData.reduce((sum, e) => sum + toTWD(e.amount, e.currency), 0);
  const pct = Math.min((totalTWD / BUDGET_TWD) * 100, 100);

  document.getElementById("budget-fill").style.width = `${pct}%`;
  document.getElementById("budget-text").textContent =
    `NT$${totalTWD.toLocaleString()} / NT$${BUDGET_TWD.toLocaleString()}`;

  // 付款人小計
  const byPayer = {};
  PAYERS.forEach(p => byPayer[p] = 0);
  expenseData.forEach(e => { byPayer[e.paidBy] = (byPayer[e.paidBy] || 0) + toTWD(e.amount, e.currency); });

  const payerSummary = document.getElementById("payer-summary");
  payerSummary.innerHTML = PAYERS.map(p => `
    <div class="payer-card ${activePayerFilter === p ? 'active' : ''}" data-payer="${p}">
      <div class="payer-name">${p}</div>
      <div class="payer-amount">NT$${(byPayer[p] || 0).toLocaleString()}</div>
    </div>
  `).join("");
  payerSummary.querySelectorAll(".payer-card").forEach(card => {
    card.addEventListener("click", () => {
      const p = card.dataset.payer;
      activePayerFilter = activePayerFilter === p ? null : p;
      renderExpenses();
    });
  });

  // 花費列表（套用 filter）
  const filtered = activePayerFilter
    ? expenseData.filter(e => e.paidBy === activePayerFilter)
    : expenseData;

  const list = document.getElementById("expense-list");
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><i data-lucide="receipt"></i><p>${activePayerFilter ? `${activePayerFilter} 還沒有花費` : '還沒有花費紀錄'}</p></div>`;
    lucide.createIcons();
    return;
  }

  list.innerHTML = filtered.map(e => {
    const twd = toTWD(e.amount, e.currency);
    const orig = e.currency === "USD" ? `US$${e.amount.toLocaleString()}` : "";
    return `
      <div class="swipe-row" data-id="${e.id}">
        <div class="swipe-actions">
          <button class="swipe-btn swipe-edit btn-edit-expense" data-id="${e.id}"><i data-lucide="pencil"></i>編輯</button>
          <button class="swipe-btn swipe-delete btn-del-expense" data-id="${e.id}"><i data-lucide="trash-2"></i>刪除</button>
        </div>
        <div class="expense-card card-swipeable" data-id="${e.id}">
          <div class="expense-info">
            <div class="expense-desc">${e.description}</div>
            <div class="expense-meta">${e.date} · ${e.paidBy}</div>
          </div>
          <div class="expense-amount">
            <div class="expense-twd">NT$${twd.toLocaleString()}</div>
            ${orig ? `<div class="expense-orig">${orig}</div>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join("");
  lucide.createIcons();
  setupSwipeRows(list, ".expense-card.card-swipeable");

  list.querySelectorAll(".btn-del-expense").forEach(btn => {
    btn.addEventListener("click", () => deleteExpense(btn.dataset.id));
  });
  list.querySelectorAll(".btn-edit-expense").forEach(btn => {
    btn.addEventListener("click", () => {
      const e = expenseData.find(x => x.id === btn.dataset.id);
      if (e) openExpenseForm(e);
    });
  });
}

function expenseFormHTML(e = {}) {
  const today = dateStr(new Date());
  return `
    <div class="form-group">
      <label>項目名稱 *</label>
      <input id="e-desc" value="${e.description || ''}" placeholder="例：環球影城門票" />
    </div>
    <div class="form-group">
      <label>幣別</label>
      <select id="e-currency">
        <option value="TWD" ${e.currency === 'TWD' || !e.currency ? 'selected' : ''}>台幣 TWD</option>
        <option value="USD" ${e.currency === 'USD' ? 'selected' : ''}>美金 USD</option>
      </select>
    </div>
    <div class="form-group">
      <label>金額 *</label>
      <input id="e-amount" type="number" min="0" step="0.01" value="${e.amount || ''}" placeholder="0" />
    </div>
    <div class="form-group">
      <label>付款人 *</label>
      <select id="e-payer">
        ${PAYERS.map(p => `<option value="${p}" ${e.paidBy === p ? 'selected' : ''}>${p}</option>`).join("")}
      </select>
    </div>
    <div class="form-group">
      <label>日期</label>
      <input id="e-date" type="date" value="${e.date || today}" />
    </div>
    <div class="form-actions">
      <button class="btn btn-ghost" id="e-cancel">取消</button>
      <button class="btn btn-primary" id="e-save">儲存</button>
    </div>
  `;
}

async function openExpenseForm(expense = null) {
  openModal(expense ? "編輯花費" : "新增花費", expenseFormHTML(expense || {}));
  document.getElementById("e-cancel").addEventListener("click", () => closeModal());
  document.getElementById("e-save").addEventListener("click", async () => {
    const desc = formVal("e-desc");
    const amountStr = formVal("e-amount");
    if (!desc || !amountStr) { alert("請填寫項目名稱與金額"); return; }
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) { alert("請輸入有效金額"); return; }

    const data = {
      description: desc,
      currency: formVal("e-currency"),
      amount,
      paidBy: formVal("e-payer"),
      date: formVal("e-date") || dateStr(new Date()),
      createdAt: expense?.createdAt ?? new Date().toISOString(),
    };

    const { addDoc, updateDoc, doc, collection } = window.__fs;
    const db = window.__db;
    try {
      if (expense) {
        await updateDoc(doc(db, "expenses", expense.id), data);
      } else {
        await addDoc(collection(db, "expenses"), data);
      }
      closeModal();
    } catch(err) {
      alert("儲存失敗：" + err.message);
    }
  });
}

async function deleteExpense(id) {
  if (!confirm("確定要刪除這筆花費？")) return;
  const { doc, deleteDoc } = window.__fs;
  await deleteDoc(doc(window.__db, "expenses", id));
}
