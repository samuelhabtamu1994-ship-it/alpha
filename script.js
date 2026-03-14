// ==================================================================
//  ALPHA BINGO — script.js
//  Full production Telegram Mini App logic with Firebase Realtime DB
// ==================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, set, get, onValue, update, push, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ===== FIREBASE INIT =====
const firebaseConfig = {
  apiKey: "AIzaSyAZxHUnuaRNc6GfJQHNBnggJ_jfZFt_0mA",
  authDomain: "baron-24c9e.firebaseapp.com",
  projectId: "baron-24c9e",
  storageBucket: "baron-24c9e.firebasestorage.app",
  messagingSenderId: "559650974936",
  appId: "1:559650974936:web:dd133acca1be5fec8cfbad",
  databaseURL: "https://alpha-bingo-default-rtdb.firebaseio.com"
};
const fbApp  = initializeApp(firebaseConfig);
const db     = getDatabase(fbApp);

// ===== TELEGRAM WEBAPP =====
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const tgUser = tg?.initDataUnsafe?.user || {
  id: "demo_" + Math.floor(Math.random() * 9999),
  first_name: "Demo",
  last_name: "User",
  username: "demo_user"
};
const UID = String(tgUser.id);

// ===== CONSTANTS =====
const JOIN_SEC  = 30;
const CALL_MS   = 3500;   // ms between number calls
const MAX_CALLS = 20;     // max calls per game — 20 × 3.5s = 70s
// GAME_SEC must cover full game: MAX_CALLS × CALL_MS/1000 + buffer
const GAME_SEC  = 90;     // 70s game + 20s buffer = 90s
const COMMISSION = 0.10;  // 10%
const MIN_REAL   = 1;     // minimum real players to start
const MAX_PLAYERS = 20;   // maximum in a room
const NO_PLAYER_STAKES = new Set([]);

const BOT_NAMES = [
  "bek***","ale**","muli**","aben***","fits**","hayl**",
  "mery**","kedi**","tseg**","dagi**","abdu**","eyer**",
  "kal***","nati**","geta***","zelu**","daw***","rob**","feti**"
];

const STAKE_CONFIG = [
  { amount: 10,  theme: "sc-gold",   icon: "🎯", min: 7,  max: 18 },
  { amount: 20,  theme: "sc-green",  icon: "🎲", min: 5,  max: 15 },
  { amount: 50,  theme: "sc-cyan",   icon: "💎", min: 3,  max: 10 },
  { amount: 100, theme: "sc-purple", icon: "👑", min: 4,  max: 12 }
];

// ===== STATE =====
let userBalance = 0;
let selectedStake  = 10;
let selectedCardNo = 1;
let currentRoomId  = null;
let roomListener   = null;
let callerInterval = null;
let isHost         = false;
let gameCardNums   = [];
let daubedSet      = new Set();
let myUsername     = tgUser.username || tgUser.first_name || "player";
let gameUIInitialized = false;
let currentRoomJoinDeadline = 0; // ms timestamp from Firebase room

// ===== SYNCHRONIZED CYCLE =====
// All users share the same cycle based on a fixed epoch anchor
// Cycle period = JOIN_SEC + GAME_SEC seconds, ticking from a known UTC anchor
const CYCLE_PERIOD = JOIN_SEC + GAME_SEC; // 90s total

function getSyncedCycleState(amount) {
  // Use a per-stake offset so different stakes are out of phase
  const stakeOffset = [10, 20, 50, 100].indexOf(amount) * 22;
  const nowSec = Math.floor(Date.now() / 1000) + stakeOffset;
  const pos = nowSec % CYCLE_PERIOD;
  const phase = pos < JOIN_SEC ? "join" : "started";
  const elapsed = pos < JOIN_SEC ? pos : pos - JOIN_SEC;
  return { phase, pos, elapsed };
}

const cycleState = {};
STAKE_CONFIG.forEach(s => {
  if (NO_PLAYER_STAKES.has(s.amount)) {
    cycleState[s.amount] = { phase: "none", pos: 0, elapsed: 0 };
  } else {
    cycleState[s.amount] = getSyncedCycleState(s.amount);
  }
});

// ===== DOM SHORTCUTS =====
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ===== SCREENS =====
function showScreen(id) {
  $$(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
  // Disable top bar buttons during game
  const topBar = document.querySelector(".top-bar");
  if (topBar) {
    if (id === "screen-game") {
      topBar.classList.add("top-bar-disabled");
    } else {
      topBar.classList.remove("top-bar-disabled");
    }
  }
}

// ===== TOAST =====
let toastTimer;
function toast(msg, dur = 2800) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), dur);
}

// ===== COPY =====
function copyPhone() {
  const num = $("depositPhone").textContent;
  navigator.clipboard?.writeText(num)
    .then(() => toast("✅ ቁጥሩ ተገልብጧል!"))
    .catch(() => { /* fallback */ });
}
window.copyPhone = copyPhone;

// ===== MENU =====
function openMenu() {
  if ($("screen-game").classList.contains("active")) return;
  $("sideMenu").classList.add("open");
  $("menuOverlay").classList.add("open");
}
function closeMenu() {
  $("sideMenu").classList.remove("open");
  $("menuOverlay").classList.remove("open");
}
window.openMenu  = openMenu;
window.closeMenu = closeMenu;
window.openDeposit = async () => {
  showScreen("screen-deposit");
  loadDepositHistory();
  try {
    const [cfgSnap, userSnap] = await Promise.all([
      get(ref(db, "botSettings")),
      get(ref(db, "users/" + UID))
    ]);
    const cfg  = cfgSnap.exists()  ? cfgSnap.val()  : {};
    const user = userSnap.exists() ? userSnap.val() : {};

    // ስምና ቁጥር
    const nameEl  = document.getElementById("depositAccountName");
    const phoneEl = document.getElementById("depositPhone");
    if (nameEl)  nameEl.textContent  = cfg.depositName  || "Getachew Abera";
    if (phoneEl) phoneEl.textContent = cfg.depositPhone || "0990633294";

    // Bonus banner
    const banner = document.getElementById("bonusBanner");
    if (banner) {
      const isFirst  = !user.firstDepositDone;
      const bonusOn  = cfg.firstDepositBonus === true;
      const pct      = cfg.firstDepositBonusPct || 50;
      if (isFirst && bonusOn) {
        banner.textContent = "🎁 First Deposit Bonus " + pct + "% — ዛሬ ይጠቀሙ!";
        banner.style.display = "block";
      } else {
        banner.style.display = "none";
      }
    }
  } catch(e) {
    console.error("[openDeposit] settings load error:", e);
  }
};
window.openWithdraw = () => {
  showScreen("screen-withdraw");
  $("withdrawBalanceDisplay").textContent = userBalance.toFixed(2) + " ETB";
  loadWithdrawHistory();
};
window.openWalletModal = () => {
  if ($("screen-game").classList.contains("active")) return;
  $("wmBalance").textContent = userBalance.toFixed(2);
  $("walletModalOverlay").classList.add("active");
  $("walletModal").classList.add("active");
};
window.closeWalletModal = () => {
  $("walletModalOverlay").classList.remove("active");
  $("walletModal").classList.remove("active");
};

// ===== UPDATE UI BALANCE =====
function updateBalanceUI() {
  $("topBalance").textContent = userBalance;
  $("menuBalance").textContent = userBalance;
}

// ===== USER INIT =====
// helper — avatar element ን photo ወይም initials ያሳያል
function _setAvatar(el, photoUrl, name) {
  if (!el) return;
  if (photoUrl) {
    el.style.backgroundImage  = "url(" + photoUrl + ")";
    el.style.backgroundSize   = "cover";
    el.style.backgroundPosition = "center";
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = (name?.[0] || "?").toUpperCase();
  }
}

async function initUser() {
  const uRef  = ref(db, `users/${UID}`);
  const snap  = await get(uRef);
  const photo = tgUser.photo_url || null;

  // Menu avatar
  _setAvatar($("menuAvatar"), photo, tgUser.first_name);
  $("menuName").textContent  = `${tgUser.first_name || ""} ${tgUser.last_name || ""}`.trim() || "Player";
  $("menuPhone").textContent = "Telegram ID: " + UID;

  if (!snap.exists()) {
    await set(uRef, {
      uid:       UID,
      name:      `${tgUser.first_name || ""} ${tgUser.last_name || ""}`.trim(),
      username:  tgUser.username || "",
      photo_url: photo || "",
      balance:   0,
      createdAt: serverTimestamp()
    });
    userBalance = 0;
  } else {
    const val = snap.val();
    userBalance = val.balance || 0;
    const ph = val.phone;
    if (ph) $("menuPhone").textContent = ph;
    // photo_url ዘምን ካለ update
    if (photo && photo !== val.photo_url) {
      update(uRef, { photo_url: photo });
    }
    // ካልሆነ firebase ላይ ያለውን ጠቀም
    if (!photo && val.photo_url) {
      _setAvatar($("menuAvatar"), val.photo_url, val.name || tgUser.first_name);
    }
  }

  onValue(ref(db, `users/${UID}/balance`), snap => {
    userBalance = snap.val() || 0;
    updateBalanceUI();
  });

  updateBalanceUI();
}

// ===== STAKE HOME SCREEN =====
function buildStakeGrid() {
  const grid = $("stakeGrid");
  grid.innerHTML = "";

  STAKE_CONFIG.forEach(cfg => {
    const card = document.createElement("div");
    card.className = `stake-card ${cfg.theme}`;
    card.id = `sc-${cfg.amount}`;

    const isNP = NO_PLAYER_STAKES.has(cfg.amount);

    card.innerHTML = `
      <div class="sc-ring">${cfg.icon}</div>
      <div class="sc-amount">${cfg.amount}</div>
      <div class="sc-curr">Birr</div>
      <div class="sc-divider"></div>
      <div class="sc-meta">
        <div class="sc-players">
          <span class="sc-live-dot" ${isNP ? 'style="background:#555;box-shadow:none;animation:none"' : ''}></span>
          <span><span id="sp-${cfg.amount}">${isNP ? 0 : 0}</span> ተጫዋቾች</span>
        </div>
        <div class="sc-prize">🏆 <span class="sc-prize-val" id="sw-${cfg.amount}">${isNP ? 0 : 0}</span> ETB</div>
        ${isNP
          ? `<div class="sc-no-players-label">ተጫዋች የለም</div>`
          : `<div class="sc-phase phase-join" id="sph-${cfg.amount}">
               <span class="sc-phase-dot"></span>
               <span id="sphl-${cfg.amount}">መቀላቀል ይቻላል</span>
             </div>
             <div class="sc-timer">
               <div class="sc-timer-bar"><div class="sc-timer-fill tf-join" id="stf-${cfg.amount}" style="width:100%"></div></div>
               <div class="sc-timer-val" id="stv-${cfg.amount}">30s</div>
             </div>`
        }
      </div>
    `;

    card.addEventListener("click", () => {
      if (isNP) {
        toast("⚠ ይህ stake ላይ ገና ተጫዋቾች የሉም");
        return;
      }
      showCardSelection(cfg.amount);
    });

    grid.appendChild(card);
  });
}

// ===== ASYNC CYCLE ENGINE =====
function startCycleEngine() {
  STAKE_CONFIG.forEach(cfg => {
    if (NO_PLAYER_STAKES.has(cfg.amount)) return;

    // Set initial display immediately on load
    fluctuatePlayers(cfg.amount);

    setInterval(() => {
      // Always re-derive from real clock so all users stay in sync
      const synced = getSyncedCycleState(cfg.amount);
      const st = cycleState[cfg.amount];
      const wasStarted = st.phase === "started";
      st.pos     = synced.pos;
      st.phase   = synced.phase;
      st.elapsed = synced.elapsed;

      // Detect phase transition: started → join (game ended, new cycle)
      if (wasStarted && st.phase === "join") {
        resetPlayerCount(cfg.amount, cfg.min);
      }

      updateStakeCycleUI(cfg.amount);
    }, 1000);
  });
}

function updateStakeCycleUI(amount) {
  const st  = cycleState[amount];
  const ph  = $(`sph-${amount}`);
  const lbl = $(`sphl-${amount}`);
  const tf  = $(`stf-${amount}`);
  const tv  = $(`stv-${amount}`);
  if (!ph) return;

  // Only fluctuate during join phase — freeze count when game has started
  const displayedCountBefore = parseInt(($(`sp-${amount}`) || {}).textContent) || 0;
  if (st.phase === "join" && Math.random() < 0.25) fluctuatePlayers(amount);
  const displayedCount = parseInt(($(`sp-${amount}`) || {}).textContent) || 0;

  // If 0 or 1 player showing — freeze timer at 30s, never show "started"
  if (displayedCount <= 1) {
    ph.className    = "sc-phase phase-join";
    lbl.textContent = "መቀላቀል ይቻላል";
    tf.className    = "sc-timer-fill tf-join";
    tf.style.width  = "100%";
    tv.textContent  = "30s";
  } else if (st.phase === "join") {
    const rem = JOIN_SEC - st.elapsed;
    ph.className    = "sc-phase phase-join";
    lbl.textContent = "መቀላቀል ይቻላል";
    tf.className    = "sc-timer-fill tf-join";
    tf.style.width  = ((rem / JOIN_SEC) * 100) + "%";
    tv.textContent  = rem + "s";
  } else {
    const rem = GAME_SEC - st.elapsed;
    ph.className    = "sc-phase phase-started";
    lbl.textContent = "ጨዋታ ጀምሯል";
    tf.className    = "sc-timer-fill tf-started";
    tf.style.width  = ((rem / GAME_SEC) * 100) + "%";
    tv.textContent  = rem + "s";
  }

  // Sync start button if user is on card selection for this stake
  if ($("screen-card").classList.contains("active") && selectedStake === amount) {
    updateStartBtn(amount);
  }
}

// Cache bot display max per stake — re-rolls once per cycle window
const _botDisplayCache = {};
function getBotDisplayMax(amount) {
  if (amount === 10) return 18;  // always active, max 18

  // Use cycle window as cache key so it re-rolls each new join phase
  const cycleKey = Math.floor(Date.now() / (JOIN_SEC * 1000));
  const cacheKey = amount + "_" + cycleKey;

  if (_botDisplayCache[cacheKey] !== undefined) {
    return _botDisplayCache[cacheKey];
  }

  // Clear old cache entries
  Object.keys(_botDisplayCache).forEach(k => {
    if (!k.endsWith("_" + cycleKey)) delete _botDisplayCache[k];
  });

  const rnd = Math.random();
  let result = 0;

  if (amount === 20) {
    // 40% = 0, 60% = 1-10
    result = rnd < 0.40 ? 0 : Math.floor(Math.random() * 10) + 1;
  } else if (amount === 50) {
    // 60% = 0, 40% = 1-6
    result = rnd < 0.60 ? 0 : Math.floor(Math.random() * 6) + 1;
  } else if (amount === 100) {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const active = (h > 18 || (h === 18 && m >= 0)) && (h < 21 || (h === 21 && m <= 30));
    result = active ? Math.floor(Math.random() * 4) : 0; // 0-3
  }

  _botDisplayCache[cacheKey] = result;
  return result;
}

function isBotDisplayActive(amount) {
  // Legacy helper — returns true if bots can show at all right now
  if (amount === 10) return true;
  if (amount === 20) return true;   // fluctuatePlayers will randomly zero out
  if (amount === 50) return true;   // fluctuatePlayers will randomly zero out
  if (amount === 100) {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    return (h > 18 || (h === 18 && m >= 0)) && (h < 21 || (h === 21 && m <= 30));
  }
  return true;
}

function fluctuatePlayers(amount) {
  const cfg = STAKE_CONFIG.find(c => c.amount === amount);
  if (!cfg) return;
  const el = $(`sp-${amount}`);
  const we = $(`sw-${amount}`);
  if (!el) return;

  const maxBots = getBotDisplayMax(amount);

  if (maxBots === 0) {
    el.textContent = 0;
    we.textContent = 0;
    return;
  }

  const minDisplay = amount === 10 ? cfg.min : 1;
  const cur = parseInt(el.textContent) || minDisplay;
  const chg = Math.random() > 0.45 ? Math.floor(Math.random() * 3) + 1 : -Math.floor(Math.random() * 2);
  const nxt = Math.min(Math.max(cur + chg, minDisplay), maxBots);
  el.textContent = nxt;
  we.textContent = nxt * amount;
}

function dropPlayers(amount) {
  const cfg = STAKE_CONFIG.find(c => c.amount === amount);
  if (!cfg) return;
  const el = $(`sp-${amount}`);
  const we = $(`sw-${amount}`);
  if (!el) return;
  const cur = parseInt(el.textContent) || cfg.min;
  const nxt = Math.max(cur - Math.floor(Math.random() * 2) - 1, cfg.min);
  el.textContent = nxt;
  we.textContent = nxt * amount;
}

function resetPlayerCount(amount, min) {
  const el = $(`sp-${amount}`);
  const we = $(`sw-${amount}`);
  if (!el) return;
  const val = isBotDisplayActive(amount) ? min : 0;
  el.textContent = val;
  we.textContent = val * amount;
}

// ===== CARD SELECTION =====
let pickedCardNo = 1;
let takenCards   = new Set();

async function showCardSelection(amount) {
  selectedStake = amount;
  $("cardBadge").textContent = amount + " ETB";
  pickedCardNo = 0; // 0 = no card selected yet
  showScreen("screen-card");

  // Show "ካርድ ይምረጡ" state immediately before async load
  const btn = $("startGameBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "👆 ካርድ ይምረጡ";
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";
    btn.onclick = null;
  }
  // Clear preview
  const preview = $("bingoPreview");
  if (preview) preview.innerHTML = "";
  $("cpLabel").textContent = "ካርድ አልተመረጠም";

  await loadTakenCards(amount);
  renderCardPicker();
}
window.goHome = () => {
  _joiningGame = false;
  const btn = $("startGameBtn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "🎮 ጨዋታውን ጀምር";
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
  }
  showScreen("screen-home");
};

function enableStartBtn() {
  const btn = $("startGameBtn");
  if (!btn) return;
  if (pickedCardNo === 0) {
    btn.disabled = true;
    btn.textContent = "👆 ካርድ ይምረጡ";
    btn.style.opacity = "0.5";
    btn.style.cursor = "not-allowed";
    btn.onclick = null;
    return;
  }
  const st = cycleState[selectedStake];
  // Only block if cycle is "started" AND displayed player count > 1
  // (if count is 0 or 1 no real game is running — always allow joining)
  const displayedCount = parseInt((document.getElementById("sp-" + selectedStake) || {}).textContent) || 0;
  if (st && st.phase === "started" && displayedCount > 1) {
    btn.disabled = true;
    btn.textContent = "⏳ ጨዋታ እየተካሄደ ነው... ይጠብቁ";
    btn.style.opacity = "0.55";
    btn.style.cursor = "not-allowed";
    btn.onclick = null;
  } else {
    btn.disabled = false;
    btn.textContent = "🎮 ጨዋታውን ጀምር";
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
    btn.onclick = joinGame;
  }
}

function updateStartBtn(amount) {
  const btn = $("startGameBtn");
  if (!btn) return;
  const st = cycleState[amount];
  if (!st) return;
  if (pickedCardNo === 0) {
    btn.disabled = true;
    btn.textContent = "👆 ካርድ ይምረጡ";
    btn.style.opacity = "0.5";
    btn.style.cursor  = "not-allowed";
    btn.onclick = null;
    return;
  }
  // Only block if cycle is "started" AND displayed player count > 1
  // (if count is 0 or 1 no real game is running — always allow joining)
  const displayedCount = parseInt((document.getElementById("sp-" + amount) || {}).textContent) || 0;
  if (st.phase === "started" && displayedCount > 1) {
    btn.disabled = true;
    btn.textContent = "⏳ ጨዋታ እየተካሄደ ነው... ይጠብቁ";
    btn.style.opacity = "0.55";
    btn.style.cursor  = "not-allowed";
    btn.onclick = null;
  } else {
    btn.disabled = false;
    btn.textContent = "🎮 ጨዋታውን ጀምር";
    btn.style.opacity = "1";
    btn.style.cursor  = "pointer";
    btn.onclick = joinGame;
  }
}

async function loadTakenCards(amount) {
  takenCards = new Set();

  // Step 1: get REAL players already in rooms (these have real card numbers)
  const snap = await get(ref(db, `rooms`));
  if (snap.exists()) {
    snap.forEach(roomSnap => {
      const r = roomSnap.val();
      if (r.stake !== amount || r.status === "finished") return;
      if (r.players) {
        Object.values(r.players).forEach(p => {
          if (!p.isBot && p.cardNo) takenCards.add(p.cardNo);
        });
      }
    });
  }

  // Step 2: read the DISPLAYED player count from the home screen (the fake/fluctuating number)
  const displayEl = document.getElementById(`sp-${amount}`);
  const displayedCount = displayEl ? (parseInt(displayEl.textContent) || 0) : 0;

  // Step 3: if displayed count > actual real players, fill up with deterministic fake taken cards
  // Use a seed so the same fake cards are taken consistently within a cycle window
  // Seed based on cycle window only (not elapsed seconds) so taken cards stay
  // stable during the entire join phase and only reset when a new cycle begins
  const cycleWindowId = Math.floor(Date.now() / (CYCLE_PERIOD * 1000));
  let seed = cycleWindowId * 997 + amount * 31;
  function seededRand() { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return Math.abs(seed) / 0xffffffff; }

  while (takenCards.size < displayedCount) {
    const fakeCard = Math.floor(seededRand() * 100) + 1;
    takenCards.add(fakeCard);
  }
}

function renderCardPicker() {
  const grid = $("cardPickerGrid");
  grid.innerHTML = "";
  for (let i = 1; i <= 100; i++) {
    const el = document.createElement("div");
    el.className = "cp-num" + (takenCards.has(i) ? " taken" : "") + (i === pickedCardNo ? " selected" : "");
    el.textContent = i;
    el.dataset.num = i;
    el.addEventListener("click", () => {
      if (takenCards.has(i)) return;
      pickedCardNo = i;
      $$(".cp-num").forEach(e => e.classList.remove("selected"));
      el.classList.add("selected");
      $("cpLabel").textContent = "Card #" + i;
      selectedCardNo = i;
      renderPreview(i);
      // Enable start button now that a card is picked
      enableStartBtn();
    });
    grid.appendChild(el);
  }
}

function renderPreview(seed) {
  const nums = generateCard(seed);
  const grid = $("bingoPreview");
  grid.innerHTML = "";
  nums.forEach((n, i) => {
    const cell = document.createElement("div");
    cell.className = "bp-cell" + (i === 12 ? " bp-free" : "");
    cell.textContent = i === 12 ? "⭐" : n;
    grid.appendChild(cell);
  });
}

// ===== BINGO CARD GENERATOR =====
function generateCard(seed) {
  const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
  let s = seed * 9301 + 49297;
  function rnd() { s = (s * 9301 + 49297) % 233280; return s / 233280; }
  let card = [];
  for (let col = 0; col < 5; col++) {
    let [mn, mx] = ranges[col];
    let pool = [];
    for (let n = mn; n <= mx; n++) pool.push(n);
    for (let i = pool.length - 1; i > 0; i--) {
      let j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    card.push(pool.slice(0, 5).sort((a, b) => a - b));
  }
  let result = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) result.push(card[col][row]);
  }
  result[12] = 0; // FREE
  return result;
}

function numToLetter(n) {
  if (n <= 15) return "B";
  if (n <= 30) return "I";
  if (n <= 45) return "N";
  if (n <= 60) return "G";
  return "O";
}

function shuffleArr(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ===== JOIN GAME =====
let _joiningGame = false; // prevent double-tap

async function joinGame() {
  if (_joiningGame) return; // already joining — ignore extra taps
  if (userBalance < selectedStake) {
    toast("⚠ ቀሪ ሂሳብዎ አነስተኛ ነው! Deposit ያድርጉ");
    return;
  }

  // Lock button immediately
  _joiningGame = true;
  const btn = $("startGameBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ በመጫን ላይ...";
    btn.style.opacity = "0.7";
    btn.style.cursor = "not-allowed";
  }

  try {
    selectedCardNo = pickedCardNo;

    // Deduct stake
    await update(ref(db, `users/${UID}`), { balance: userBalance - selectedStake });
    // Log stake deduction as a transaction
    const stakeTxRef = push(ref(db, `users/${UID}/transactions`));
    await set(stakeTxRef, {
      type: "stake",
      stake: selectedStake,
      amount: selectedStake,
      ts: serverTimestamp()
    });

    // Find or create room
    const roomId = await findOrCreateRoom(selectedStake);
    currentRoomId = roomId;

    // Add player to room
    await update(ref(db, `rooms/${roomId}/players/${UID}`), {
      uid: UID,
      name: myUsername,
      username: "@" + (tgUser.username || myUsername),
      cardNo: selectedCardNo,
      isBot: false,
      joinedAt: serverTimestamp()
    });

    // Fetch joinDeadline from this room so overlay countdown is accurate
    const roomSnap = await get(ref(db, `rooms/${roomId}`));
    if (roomSnap.exists() && roomSnap.val().joinDeadline) {
      currentRoomJoinDeadline = roomSnap.val().joinDeadline;
    }

    // Go directly to game screen (skip lobby), show waiting state
    gameUIInitialized = false;
    showGameScreenWaiting();

    // Listen to room
    listenRoom(roomId);
  } catch (err) {
    // On error, re-enable button so user can try again
    _joiningGame = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🎮 ጨዋታውን ጀምር";
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
    toast("❌ ስህተት ተፈጥሯል። እንደገና ይሞክሩ");
  }
}
window.joinGame = joinGame;

async function findOrCreateRoom(stake) {
  // Helper: scan for open waiting room
  async function scanForRoom() {
    const snap = await get(ref(db, "rooms"));
    if (!snap.exists()) return null;
    let found = null;
    snap.forEach(r => {
      const v = r.val();
      if (v.stake === stake && v.status === "waiting" && !found) {
        const playerCount = v.players ? Object.keys(v.players).length : 0;
        if (playerCount < MAX_PLAYERS) found = r.key;
      }
    });
    return found;
  }

  // First scan
  let found = await scanForRoom();
  if (found) return found;

  // Create new room
  const newRoom = ref(db, "rooms");
  const pushed  = push(newRoom);
  const roomId  = pushed.key;

  const joinDeadline = Date.now() + JOIN_SEC * 1000;
  await set(ref(db, `rooms/${roomId}`), {
    id: roomId,
    stake,
    status: "waiting",
    createdAt: serverTimestamp(),
    joinDeadline,
    hostUid: UID,
    players: {},
    calledNumbers: []
  });

  // Short wait then re-scan — if another room appeared in parallel, join that instead
  await new Promise(r => setTimeout(r, 800));
  const concurrent = await scanForRoom();
  if (concurrent && concurrent !== roomId) {
    // Another room opened — remove ours and join theirs
    await remove(ref(db, `rooms/${roomId}`));
    isHost = false;
    return concurrent;
  }

  isHost = true;
  return roomId;
}

function listenRoom(roomId) {
  if (roomListener) roomListener();
  roomListener = onValue(ref(db, `rooms/${roomId}`), snap => {
    if (!snap.exists()) return;
    const room = snap.val();
    handleRoomUpdate(room, roomId);
  });
}

function handleRoomUpdate(room, roomId) {
  const players     = room.players ? Object.values(room.players) : [];
  const realPlayers = players.filter(p => !p.isBot);

  if (room.status === "waiting") {
    // Sync joinDeadline so countdown stays accurate
    if (room.joinDeadline && room.joinDeadline !== currentRoomJoinDeadline) {
      currentRoomJoinDeadline = room.joinDeadline;
      startWaitingCountdown();
    }

    updateGameWaitingUI(players, room.stake);

    // HOST HANDOVER: if the original host left, earliest real player becomes new host
    const hostStillIn = room.hostUid && realPlayers.some(p => p.uid === room.hostUid);
    let amHost = (room.hostUid === UID) || isHost;

    if (!hostStillIn && realPlayers.length >= MIN_REAL) {
      const sorted = [...realPlayers].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
      if (sorted[0] && sorted[0].uid === UID) {
        amHost = true;
        isHost = true;
        update(ref(db, "rooms/" + roomId), { hostUid: UID }).catch(console.error);
      }
    }

    if (amHost && realPlayers.length >= MIN_REAL) {
      isHost = true;
      scheduleGameStart(roomId, room);
    }

  } else if (room.status === "playing") {
    hideGameWaitingOverlay();
    if (!gameUIInitialized) {
      gameUIInitialized = true;
      startGameUI(room);
    }
    syncCalledNumbers(room.calledNumbers || []);
    if (room.winner) {
      handleWinner(room.winner, room);
    }
  } else if (room.status === "finished") {
    if (room.winner && !$("screen-result").classList.contains("active")) {
      handleWinner(room.winner, room);
    }
  }
}

let startScheduled = false;
let startScheduledRoomId = null;

// ===== BOT COUNT CALCULATOR =====
function calcBotsNeeded(stake, realCount) {
  const rnd = Math.random();

  if (stake === 10) {
    // No bots if 9+ real players
    if (realCount >= 9) return 0;
    return Math.floor(Math.random() * (19 - 3 + 1)) + 3;
  }

  // For all other stakes: no bots if 3+ real players
  if (realCount >= 3) return 0;

  // Solo player (realCount === 1): always give exactly 4 bots for 20/50/100
  if (realCount === 1) return 4;

  if (stake === 20) {
    // 40% chance = 0 bots, 60% chance = 1–10 bots
    if (rnd < 0.40) return 0;
    return Math.floor(Math.random() * 10) + 1; // 1–10
  }

  if (stake === 50) {
    // 60% chance = 0 bots, 40% chance = 1–6 bots
    if (rnd < 0.60) return 0;
    return Math.floor(Math.random() * 6) + 1; // 1–6
  }

  if (stake === 100) {
    // Only between 18:00–21:30 local time: 0–3 bots, else 0
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const afterStart  = h > 18 || (h === 18 && m >= 0);
    const beforeEnd   = h < 21 || (h === 21 && m <= 30);
    if (afterStart && beforeEnd) {
      return Math.floor(Math.random() * 4); // 0–3
    }
    return 0;
  }

  return 0;
}

function scheduleGameStart(roomId, room) {
  if (startScheduled && startScheduledRoomId === roomId) return;
  startScheduled = true;
  startScheduledRoomId = roomId;

  const callOrder = shuffleArr(Array.from({length:75}, (_,i) => i+1));

  async function launchWhenReady() {
    if (!startScheduled) return;

    // Fetch fresh room data — reset & bail on any error
    let freshRoom;
    try {
      const freshSnap = await get(ref(db, `rooms/${roomId}`));
      if (!freshSnap.exists()) { startScheduled = false; startScheduledRoomId = null; return; }
      freshRoom = freshSnap.val();
    } catch(e) {
      console.error("[scheduleGameStart] fetch error:", e);
      startScheduled = false; startScheduledRoomId = null;
      return;
    }

    // Someone else already started — nothing to do
    if (freshRoom.status === "playing") {
      startScheduled = false; startScheduledRoomId = null;
      return;
    }

    const deadline = freshRoom.joinDeadline || (Date.now() + JOIN_SEC * 1000);
    const remainMs = deadline - Date.now();

    // Time remaining — come back closer to deadline
    if (remainMs > 500) {
      setTimeout(launchWhenReady, Math.min(remainMs, 2000));
      return;
    }

    // ── Deadline reached ────────────────────────────────────────
    // 1. Add bots immediately (fire-and-forget style — don't block game start)
    const realNow    = freshRoom.players
      ? Object.values(freshRoom.players).filter(p => !p.isBot).length
      : 0;
    const allPlayers = freshRoom.players ? Object.values(freshRoom.players) : [];
    const botsNeeded = calcBotsNeeded(freshRoom.stake, realNow);

    if (botsNeeded > 0) {
      const shuffledNames = shuffleArr([...BOT_NAMES]);
      const botUpdates = {};
      let bots = [...allPlayers];
      for (let i = 0; i < botsNeeded && bots.length < MAX_PLAYERS; i++) {
        const botId  = "bot_" + i + "_" + Date.now();
        const cardNo = pickBotCardNo(bots);
        botUpdates[botId] = {
          uid:      botId,
          name:     shuffledNames[i % shuffledNames.length],
          username: shuffledNames[i % shuffledNames.length],
          cardNo,
          isBot:    true,
          joinedAt: Date.now()
        };
        bots.push(botUpdates[botId]);
      }
      // Add bots in parallel with game start — don't await so it never blocks
      update(ref(db, `rooms/${roomId}/players`), botUpdates)
        .catch(e => console.error("[scheduleGameStart] bot add error:", e));
    }

    // 2. Write "playing" immediately — retries up to 3 times on failure
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await update(ref(db, `rooms/${roomId}`), {
          status:        "playing",
          startedAt:     serverTimestamp(),
          hostUid:       UID,
          callOrder,
          calledNumbers: [],
          callIndex:     0
        });
        // Success
        startScheduled = false; startScheduledRoomId = null;
        return;
      } catch(e) {
        console.error(`[scheduleGameStart] write attempt ${attempt} failed:`, e);
        if (attempt < 3) await new Promise(r => setTimeout(r, 500));
      }
    }

    // All 3 attempts failed — reset flag so the next Firebase event can retry
    console.error("[scheduleGameStart] all write attempts failed, resetting flag");
    startScheduled = false; startScheduledRoomId = null;
  }

  setTimeout(launchWhenReady, 300);
}

function pickBotCardNo(existingPlayers) {
  const taken = new Set(existingPlayers.map(p => p.cardNo).filter(Boolean));
  let n;
  do { n = Math.floor(Math.random() * 100) + 1; } while (taken.has(n));
  return n;
}

// ===== LOBBY UI =====
function updateLobbyUI(players, stake) {
  const real = players.filter(p => !p.isBot);
  const bots  = players.filter(p => p.isBot);
  $("lobbyJoined").textContent = players.length;
  $("lobbyNeeded").textContent = 6;

  const wrap = $("lobbyPlayers");
  wrap.innerHTML = "";
  real.forEach(p => {
    const chip = document.createElement("div");
    chip.className = "lp-chip lp-real";
    chip.textContent = (p.uid === UID ? "⭐ " : "") + p.username;
    wrap.appendChild(chip);
  });
  bots.slice(0, 5).forEach(p => {
    const chip = document.createElement("div");
    chip.className = "lp-chip lp-bot";
    chip.textContent = p.name;
    wrap.appendChild(chip);
  });
  if (bots.length > 5) {
    const chip = document.createElement("div");
    chip.className = "lp-chip lp-bot";
    chip.textContent = "+" + (bots.length - 5) + " bots";
    wrap.appendChild(chip);
  }
}

// ===== FIX 4: GAME SCREEN WAITING HELPERS =====
// Show game screen immediately with a waiting overlay
function showGameScreenWaiting() {
  showScreen("screen-game");
  // Build empty card and grid so the screen looks ready
  gameCardNums = generateCard(selectedCardNo);
  daubedSet = new Set([12]);
  renderGameCard(gameCardNums);
  buildCalledGrid();

  // Show waiting overlay on the game screen
  let overlay = document.getElementById("gameWaitingOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "gameWaitingOverlay";
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(10,10,20,0.88);
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      z-index:500; gap:16px;
    `;
    overlay.innerHTML = `
      <div style="width:56px;height:56px;border:4px solid #ffd700;border-top-color:transparent;border-radius:50%;animation:spin 0.9s linear infinite;"></div>
      <div style="font-family:var(--font-am);font-size:1.1rem;color:#ffd700;font-weight:700;" id="gwolTitle">ተጫዋቾችን በመጠበቅ ላይ...</div>
      <div style="font-family:var(--font-am);font-size:0.85rem;color:#aaa;" id="gwolSub">ጨዋታ እስኪጀምር ይጠብቁ...</div>
      <div style="font-size:2rem;font-weight:900;color:#fff;font-family:var(--font-main);" id="gwolTimer">30</div>

    `;
    document.body.appendChild(overlay);
  }
  overlay.style.display = "flex";
  startWaitingCountdown();
}

let _waitCountdownInt = null;
function startWaitingCountdown() {
  if (_waitCountdownInt) clearInterval(_waitCountdownInt);
  _waitCountdownInt = setInterval(async () => {
    const timerEl = document.getElementById("gwolTimer");
    const titleEl = document.getElementById("gwolTitle");
    const subEl   = document.getElementById("gwolSub");
    if (!timerEl) { clearInterval(_waitCountdownInt); _waitCountdownInt = null; return; }

    const remMs  = currentRoomJoinDeadline ? currentRoomJoinDeadline - Date.now() : -1;
    const remSec = Math.ceil(remMs / 1000);

    if (remMs > 0) {
      timerEl.textContent = remSec;
      titleEl.textContent = "ተጫዋቾችን በመጠበቅ ላይ...";
      subEl.textContent   = "ጨዋታ ሲጀምር ወዲያው ይነግርዎታል...";
    } else {
      // ── Countdown hit 0 ─────────────────────────────────────
      clearInterval(_waitCountdownInt);
      _waitCountdownInt = null;
      timerEl.textContent = "0";

      if (!currentRoomId) return;

      try {
        const snap = await get(ref(db, `rooms/${currentRoomId}`));
        if (!snap.exists()) return;
        const r = snap.val();

        if (r.status === "playing") {
          // Already playing — show board immediately
          hideGameWaitingOverlay();
          if (!gameUIInitialized) { gameUIInitialized = true; startGameUI(r); }
          syncCalledNumbers(r.calledNumbers || []);

        } else if (r.joinDeadline && r.joinDeadline > Date.now()) {
          // Host pushed deadline — restart countdown with new value
          currentRoomJoinDeadline = r.joinDeadline;
          startWaitingCountdown();

        } else {
          // ── BACKUP HOST LOGIC ──────────────────────────────
          // Status is still "waiting" and deadline has passed.
          // Any player (not just the host) attempts to start the game.
          // This handles the case where the original host disconnected.
          if (!startScheduled) {
            startScheduled = true;
            startScheduledRoomId = currentRoomId;
            const callOrder = shuffleArr(Array.from({length:75}, (_,i) => i+1));

            const realNow    = r.players ? Object.values(r.players).filter(p => !p.isBot).length : 0;
            const allPlayers = r.players ? Object.values(r.players) : [];
            const botsNeeded = calcBotsNeeded(r.stake, realNow);

            // Add bots async without blocking
            if (botsNeeded > 0) {
              const shuffledNames = shuffleArr([...BOT_NAMES]);
              const botUpdates = {};
              let bots = [...allPlayers];
              for (let i = 0; i < botsNeeded && bots.length < MAX_PLAYERS; i++) {
                const botId  = "bot_" + i + "_" + Date.now();
                const cardNo = pickBotCardNo(bots);
                botUpdates[botId] = {
                  uid: botId, name: shuffledNames[i % shuffledNames.length],
                  username: shuffledNames[i % shuffledNames.length],
                  cardNo, isBot: true, joinedAt: Date.now()
                };
                bots.push(botUpdates[botId]);
              }
              update(ref(db, `rooms/${currentRoomId}/players`), botUpdates)
                .catch(e => console.error("[backup] bot add error:", e));
            }

            // Write "playing" — retry up to 3 times
            (async () => {
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  await update(ref(db, `rooms/${currentRoomId}`), {
                    status:        "playing",
                    startedAt:     serverTimestamp(),
                    hostUid:       UID,
                    callOrder,
                    calledNumbers: [],
                    callIndex:     0
                  });
                  startScheduled = false; startScheduledRoomId = null;
                  return;
                } catch(e) {
                  console.error(`[backup] write attempt ${attempt} failed:`, e);
                  if (attempt < 3) await new Promise(res => setTimeout(res, 500));
                }
              }
              startScheduled = false; startScheduledRoomId = null;
            })();
          }

          // While backup host is writing, keep polling so UI reacts as soon as
          // Firebase fires — either from this client or the original host
          (function pollUntilPlaying() {
            if (!currentRoomId) return;
            get(ref(db, `rooms/${currentRoomId}`))
              .then(s => {
                if (!s.exists()) return;
                const rv = s.val();
                if (rv.status === "playing") {
                  hideGameWaitingOverlay();
                  if (!gameUIInitialized) { gameUIInitialized = true; startGameUI(rv); }
                  syncCalledNumbers(rv.calledNumbers || []);
                } else {
                  setTimeout(pollUntilPlaying, 500);
                }
              })
              .catch(e => { console.error("[poll]", e); setTimeout(pollUntilPlaying, 1000); });
          })();
        }
      } catch(e) { console.error("[countdown end]", e); }
    }
  }, 1000);
}

function updateGameWaitingUI(players, stake) {
  // No-op: countdown is driven purely by joinDeadline in startWaitingCountdown
}

function hideGameWaitingOverlay() {
  if (_waitCountdownInt) { clearInterval(_waitCountdownInt); _waitCountdownInt = null; }
  const overlay = document.getElementById("gameWaitingOverlay");
  if (overlay) overlay.style.display = "none";
}

function cancelLobby() {
  if (roomListener) { roomListener(); roomListener = null; }
  if (currentRoomId) {
    // FIX 6: Remove player from room but NO refund — stake is forfeited
    remove(ref(db, `rooms/${currentRoomId}/players/${UID}`));
  }
  hideGameWaitingOverlay();
  startScheduled = false;
  currentRoomId  = null;
  isHost = false;
  showScreen("screen-home");
  toast("🚪 ጨዋታ ተሰርዟል።");
}
window.cancelLobby = cancelLobby;

// ===== GAME UI =====
function startGameUI(room) {
  showScreen("screen-game");
  const players = room.players ? Object.values(room.players) : [];

  $("gtbRound").textContent   = "Stake: " + room.stake + " ETB";
  $("gtbPlayers").textContent = "👥 " + players.length;

  // FIX 2: Fetch fresh room data to get all players including bots for accurate prize
  get(ref(db, `rooms/${currentRoomId}`)).then(snap => {
    if (!snap.exists()) return;
    const freshRoom = snap.val();
    const allPlayers = freshRoom.players ? Object.values(freshRoom.players) : [];
    const prize = calcPrize(allPlayers.length, freshRoom.stake);
    $("gtbPrize").textContent   = "🏆 " + prize + " ETB";
    $("gtbPlayers").textContent = "👥 " + allPlayers.length;
    renderPlayersStrip(allPlayers);
  });

  // Build player card
  gameCardNums = generateCard(selectedCardNo);
  daubedSet = new Set([12]); // FREE center
  renderGameCard(gameCardNums);
  buildCalledGrid();

  // Players strip (initial render, updated above after fetch)
  renderPlayersStrip(players);

  // Determine host from room data (reliable — not from local isHost flag)
  if (room.hostUid === UID) {
    isHost = true;
    startCallerLoop(currentRoomId);
  }
}

function renderGameCard(nums) {
  const grid = $("gameCard");
  grid.innerHTML = "";
  nums.forEach((n, i) => {
    const cell = document.createElement("div");
    cell.className = "gc-cell" + (i === 12 ? " gc-free" : "");
    cell.dataset.idx = i;
    cell.textContent = i === 12 ? "FREE" : n;
    if (i !== 12) cell.addEventListener("click", () => manualDaub(i));
    grid.appendChild(cell);
  });
}

function buildCalledGrid() {
  const grid = $("calledGrid");
  grid.innerHTML = "";

  // Column definitions: letter, color class, range start
  const cols = [
    { letter: "B", cls: "b", start: 1  },
    { letter: "I", cls: "i", start: 16 },
    { letter: "N", cls: "n", start: 31 },
    { letter: "G", cls: "g", start: 46 },
    { letter: "O", cls: "o", start: 61 },
  ];

  // Build row by row: first row = headers, then 15 rows of numbers
  // Grid is 5 columns × 16 rows (1 header + 15 numbers)
  for (let row = 0; row < 16; row++) {
    cols.forEach(col => {
      if (row === 0) {
        // Header row
        const h = document.createElement("div");
        h.className = "cg-col-header cg-h" + col.cls;
        h.textContent = col.letter;
        grid.appendChild(h);
      } else {
        const n = col.start + (row - 1);
        const el = document.createElement("div");
        el.id = "cg-" + n;
        el.className = "cg-num cg-" + col.cls;
        el.textContent = n;
        grid.appendChild(el);
      }
    });
  }
}

function renderPlayersStrip(players) {
  // Players strip hidden per design update
  const strip = $("playersStrip");
  if (strip) strip.innerHTML = "";
}

function calcPrize(playerCount, stake) {
  return Math.floor(playerCount * stake * (1 - COMMISSION));
}

// ===== CALLER LOOP (HOST) =====
function startCallerLoop(roomId) {
  if (callerInterval) clearInterval(callerInterval);
  callerInterval = setInterval(async () => {
    const snap = await get(ref(db, `rooms/${roomId}`));
    if (!snap.exists()) { clearInterval(callerInterval); return; }
    const room = snap.val();
    if (room.status !== "playing" || room.winner) {
      clearInterval(callerInterval); return;
    }

    const callOrder = room.callOrder || [];
    const idx = room.callIndex || 0;

    if (idx >= callOrder.length || idx >= MAX_CALLS) {
      clearInterval(callerInterval);
      // If we hit max calls and no winner yet, find best scoring player
      if (idx >= MAX_CALLS && !room.winner) {
        forceWinnerAt20(room, roomId);
      }
      return;
    }

    const num = callOrder[idx];
    const calledNumbers = [...(room.calledNumbers || []), num];

    await update(ref(db, `rooms/${roomId}`), {
      calledNumbers,
      callIndex: idx + 1,
      lastCalled: num
    });

    // Bot auto-check bingo after each call
    if (room.players) {
      checkBotBingo(room, calledNumbers, roomId);
    }
  }, CALL_MS);
}

// ===== SYNC CALLED NUMBERS =====
function syncCalledNumbers(calledNums) {
  if (!calledNums || !calledNums.length) return;
  const latest = calledNums[calledNums.length - 1];

  // Update call counter
  const countEl = $("gtbCallCount");
  if (countEl) countEl.textContent = `Call ${calledNums.length}/${MAX_CALLS}`;

  // Big display
  $("currentCallLetter").textContent = numToLetter(latest);
  const numEl = $("currentCallNumber");
  numEl.textContent = latest;
  numEl.style.animation = "none";
  void numEl.offsetWidth;
  numEl.style.animation = "";

  // History strip (last 4)
  const strip = $("callHistory");
  strip.innerHTML = "";
  const last4 = calledNums.slice(-5, -1).reverse();
  last4.forEach(n => {
    const ball = document.createElement("div");
    ball.className = "ch-ball chb-" + numToLetter(n).toLowerCase();
    ball.textContent = n;
    strip.appendChild(ball);
  });

  // Called grid
  calledNums.forEach(n => {
    const el = $("cg-" + n);
    if (el) el.classList.add("cg-called");
  });

  // Auto-daub player card
  gameCardNums.forEach((n, i) => {
    if (n !== 0 && calledNums.includes(n)) {
      daubedSet.add(i);
      const cell = document.querySelector(`#gameCard [data-idx="${i}"]`);
      if (cell && !cell.classList.contains("gc-daubed")) {
        cell.classList.add("gc-called", "gc-daubed");
      }
    }
  });

  // Check bingo eligibility
  if (checkBingo(daubedSet)) {
    $("bingoShoutBtn").classList.add("ready");
  }
}

// ===== MANUAL DAUB =====
function manualDaub(idx) {
  const num = gameCardNums[idx];
  const cell = document.querySelector(`#gameCard [data-idx="${idx}"]`);
  if (!cell) return;

  const snap_ref = ref(db, `rooms/${currentRoomId}/calledNumbers`);
  get(snap_ref).then(snap => {
    const called = snap.val() || [];
    if (called.includes(num)) {
      daubedSet.add(idx);
      cell.classList.add("gc-daubed");
      if (checkBingo(daubedSet)) $("bingoShoutBtn").classList.add("ready");
    } else {
      toast("⚠ ይህ ቁጥር ገና አልተጠራም!");
    }
  });
}

// ===== BINGO CHECK =====
function checkBingo(daubed) {
  // Rows
  for (let r = 0; r < 5; r++) {
    let ok = true;
    for (let c = 0; c < 5; c++) { if (!daubed.has(r*5+c)) { ok=false; break; } }
    if (ok) return true;
  }
  // Cols
  for (let c = 0; c < 5; c++) {
    let ok = true;
    for (let r = 0; r < 5; r++) { if (!daubed.has(r*5+c)) { ok=false; break; } }
    if (ok) return true;
  }
  // Diagonals
  let d1=true, d2=true;
  for (let i=0;i<5;i++) {
    if (!daubed.has(i*5+i)) d1=false;
    if (!daubed.has(i*5+(4-i))) d2=false;
  }
  return d1||d2;
}

function getWinCells(daubed) {
  const wins = new Set();
  for (let r=0;r<5;r++) {
    let ok=true; let cells=[];
    for (let c=0;c<5;c++){cells.push(r*5+c); if(!daubed.has(r*5+c)){ok=false;break;}}
    if(ok) cells.forEach(x=>wins.add(x));
  }
  for (let c=0;c<5;c++) {
    let ok=true; let cells=[];
    for (let r=0;r<5;r++){cells.push(r*5+c); if(!daubed.has(r*5+c)){ok=false;break;}}
    if(ok) cells.forEach(x=>wins.add(x));
  }
  let d1c=[],d2c=[],d1=true,d2=true;
  for(let i=0;i<5;i++){
    d1c.push(i*5+i); d2c.push(i*5+(4-i));
    if(!daubed.has(i*5+i)) d1=false;
    if(!daubed.has(i*5+(4-i))) d2=false;
  }
  if(d1) d1c.forEach(x=>wins.add(x));
  if(d2) d2c.forEach(x=>wins.add(x));
  return wins;
}

// ===== SHOUT BINGO =====
async function shoutBingo() {
  if (!checkBingo(daubedSet)) {
    toast("⚠ ገና ቢንጎ አልሆነም! ቁጥሮችዎ ገና አልተዛመዱም");
    return;
  }
  const snap = await get(ref(db, `rooms/${currentRoomId}`));
  if (!snap.exists()) return;
  const room = snap.val();
  if (room.winner) { toast("😞 ቀድሞ አሸናፊ ተወስኗል!"); return; }

  const players = room.players ? Object.values(room.players) : [];
  const prize   = calcPrize(players.length, room.stake);

  // Set winner
  await update(ref(db, `rooms/${currentRoomId}`), {
    winner: { uid: UID, username: "@" + (tgUser.username || myUsername), isBot: false, prize },
    status: "finished"
  });

  // Credit prize
  await update(ref(db, `users/${UID}`), { balance: userBalance + prize });

  // Log transaction
  const txRef = push(ref(db, `users/${UID}/transactions`));
  await set(txRef, {
    type: "win", amount: prize, roomId: currentRoomId,
    stake: room.stake, ts: serverTimestamp()
  });

  if (callerInterval) { clearInterval(callerInterval); callerInterval = null; }
  highlightWinCells();
  showResultScreen(true, prize, "@" + (tgUser.username || myUsername));
  launchConfetti();
}
window.shoutBingo = shoutBingo;

function highlightWinCells() {
  const wins = getWinCells(daubedSet);
  wins.forEach(idx => {
    const cell = document.querySelector(`#gameCard [data-idx="${idx}"]`);
    if (cell) cell.classList.add("gc-win");
  });
}

// ===== BOT BINGO CHECK =====
function checkBotBingo(room, calledNumbers, roomId) {
  if (room.winner) return;
  const players = Object.values(room.players);
  const bots = players.filter(p => p.isBot);

  if (calledNumbers.length < MAX_CALLS) return;

  // At exactly MAX_CALLS, find the bot with most matches and declare winner
  let bestBot = null;
  let bestScore = -1;
  bots.forEach(bot => {
    const botCard   = generateCard(bot.cardNo, room.stake);
    const botDaubed = buildBotDaubed(botCard, calledNumbers);
    const score = botDaubed.size;
    if (score > bestScore) { bestScore = score; bestBot = bot; }
  });

  if (bestBot) {
    const prize = calcPrize(players.length, room.stake);
    update(ref(db, `rooms/${roomId}`), {
      winner: { uid: bestBot.uid, username: bestBot.username, isBot: true, prize },
      status: "finished"
    });
  }
}

// Force winner when 20 calls reached — picks real player or best bot
async function forceWinnerAt20(room, roomId) {
  const players    = Object.values(room.players || {});
  const called     = room.calledNumbers || [];
  const prize      = calcPrize(players.length, room.stake);

  let bestPlayer = null;
  let bestScore  = -1;
  players.forEach(p => {
    const card   = generateCard(p.cardNo, room.stake);
    const daubed = buildBotDaubed(card, called);
    if (daubed.size > bestScore) { bestScore = daubed.size; bestPlayer = p; }
  });

  if (bestPlayer && !room.winner) {
    await update(ref(db, `rooms/${roomId}`), {
      winner: {
        uid: bestPlayer.uid,
        username: bestPlayer.username || bestPlayer.name,
        isBot: !!bestPlayer.isBot,
        prize
      },
      status: "finished"
    });
  }
}

function buildBotDaubed(cardNums, calledNumbers) {
  const d = new Set([12]);
  cardNums.forEach((n, i) => {
    if (n !== 0 && calledNumbers.includes(n)) d.add(i);
  });
  return d;
}

// ===== WINNER HANDLING =====
function handleWinner(winner, room) {
  if (callerInterval) { clearInterval(callerInterval); callerInterval = null; }

  if (winner.uid === UID) return; // Already handled in shoutBingo

  const isLoss = winner.uid !== UID;
  if (isLoss) {
    showResultScreen(false, room.stake, winner.username || "Unknown");
  }
}

function showResultScreen(won, amount, winnerName) {
  const el_emoji  = $("resultEmoji");
  const el_title  = $("resultTitle");
  const el_amount = $("resultAmount");
  const el_winner = $("resultWinner");
  const el_sub    = $("resultSub");

  if (won) {
    el_emoji.textContent  = "🏆";
    el_title.textContent  = "አሸነፉ!";
    el_title.className    = "result-title";
    el_amount.textContent = "+" + amount + " ETB";
    el_amount.className   = "result-amount";
    el_winner.textContent = "Winner: " + winnerName;
    el_sub.textContent    = "ሽልማቱ ወደ ሂሳብዎ ተጨምሯል";
  } else {
    el_emoji.textContent  = "😞";
    el_title.textContent  = "አልተሳካም";
    el_title.className    = "result-title loss";
    el_amount.textContent = "-" + amount + " ETB";
    el_amount.className   = "result-amount loss";
    el_winner.textContent = "Winner: " + winnerName;
    el_sub.textContent    = "ሌላ ተጫዋች አሸንፏል። እንደገና ይሞክሩ!";
  }

  showScreen("screen-result");
  cleanupGame();
}

function cleanupGame() {
  if (roomListener) { roomListener(); roomListener = null; }
  if (callerInterval) { clearInterval(callerInterval); callerInterval = null; }
  currentRoomId = null;
  isHost = false;
  startScheduled = false;
  gameUIInitialized = false;
  _joiningGame = false;
  startScheduled = false;
  startScheduledRoomId = null;
  currentRoomJoinDeadline = 0;
  daubedSet = new Set();
  gameCardNums = [];
}

// ===== LEAVE GAME =====
function leaveGame() {
  // Show confirmation dialog instead of leaving immediately
  const overlay = document.createElement("div");
  overlay.id = "leaveConfirmOverlay";
  overlay.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,0.75);
    display:flex; align-items:center; justify-content:center;
    z-index:9999;
  `;
  overlay.innerHTML = `
    <div style="
      background:#0d1022; border:1px solid rgba(255,215,0,0.25);
      border-radius:18px; padding:28px 24px; max-width:280px; width:90%;
      text-align:center; box-shadow:0 8px 40px rgba(0,0,0,0.7);
    ">
      <div style="font-size:2rem; margin-bottom:10px;">⚠️</div>
      <div style="font-family:var(--font-am); font-size:1rem; font-weight:700; color:#fff; margin-bottom:8px;">
        ጨዋታውን ለቀው መውጣት ይፈልጋሉ?
      </div>
      <div style="font-family:var(--font-am); font-size:0.78rem; color:#aaa; margin-bottom:22px;">
        ጨዋታው ይቀጥላል፣ ግን ሂሳብዎ አይመለስም።
      </div>
      <div style="display:flex; gap:12px; justify-content:center;">
        <button id="leaveConfirmYes" style="
          flex:1; padding:12px; border-radius:10px;
          background:linear-gradient(135deg,#ff4444,#ff1744);
          color:#fff; font-weight:800; font-size:0.9rem;
          border:none; cursor:pointer;
        ">አዎ፣ ውጣ</button>
        <button id="leaveConfirmNo" style="
          flex:1; padding:12px; border-radius:10px;
          background:rgba(255,255,255,0.08);
          border:1px solid rgba(255,255,255,0.15);
          color:#fff; font-weight:800; font-size:0.9rem;
          cursor:pointer;
        ">አይ፣ ቀጥል</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("leaveConfirmYes").onclick = () => {
    overlay.remove();
    if (currentRoomId) {
      remove(ref(db, `rooms/${currentRoomId}/players/${UID}`));
    }
    cleanupGame();
    showScreen("screen-home");
    toast("🚪 ጨዋታውን ለቅቀዋል");
  };
  document.getElementById("leaveConfirmNo").onclick = () => {
    overlay.remove();
  };
}
window.leaveGame = leaveGame;

// ===== DEPOSIT =====

// SMS ወይም transaction ID ከ raw text ያወጣል
function _extractTxId(input) {
  if (!input) return null;
  // Full SMS ሆኖ ከ "transaction number is XXXXX" ቅርጽ ካለ ያውጣ
  const match = input.match(/transaction\s+number\s+is\s+([A-Z0-9]+)/i);
  if (match) return match[1].trim().toUpperCase();
  // አጭር ID ብቻ ከሆነ (ከ 5 እስከ 20 chars) ቀጥታ ይጠቀም
  const clean = input.trim().toUpperCase();
  if (/^[A-Z0-9]{5,20}$/.test(clean)) return clean;
  return null;
}

async function submitDeposit() {
  const amt = parseFloat($("depAmount").value);
  const sms = $("depSms").value.trim();

  if (!amt || amt < 50) { toast("⚠ ቢያንስ 50 ETB ያስገቡ!"); return; }
  if (!sms) { toast("⚠ Transaction ID ወይም SMS ያስገቡ!"); return; }

  // txId ያውጣ
  const txId = _extractTxId(sms);
  if (!txId) { toast("⚠ ትክክለኛ Transaction ID ያስገቡ (ምሳሌ: DCA7MX5IOZ)"); return; }

  // ── Duplicate txId check ──────────────────────────────────
  const usedSnap = await get(ref(db, `usedTxIds/${txId}`));
  if (usedSnap.exists()) {
    toast("❌ ይህ Transaction ID ቀደም ሲሉ ጥቅም ላይ ውሏል!");
    return;
  }

  // ── Already pending with same txId? ─────────────────────
  const myTxSnap = await get(ref(db, `users/${UID}/transactions`));
  if (myTxSnap.exists()) {
    let alreadyPending = false;
    myTxSnap.forEach(child => {
      const t = child.val();
      if (t.type === "deposit" && t.txId === txId &&
          (t.status === "pending" || t.status === "approved")) {
        alreadyPending = true;
      }
    });
    if (alreadyPending) {
      toast("❌ ይህ Transaction ID ቀደም ሲሉ ጥቅም ላይ ውሏል!");
      return;
    }
  }

  // ── Save to Firebase ─────────────────────────────────────
  const txRef    = push(ref(db, `users/${UID}/transactions`));
  const adminRef = push(ref(db, `depositRequests`));
  const txKey    = txRef.key;

  await set(txRef, {
    type: "deposit", status: "pending",
    amount: amt, sms, txId,
    uid: UID,
    username: tgUser.username || myUsername,
    ts: serverTimestamp()
  });

  await set(adminRef, {
    uid: UID,
    username: tgUser.username || myUsername,
    name: `${tgUser.first_name||""} ${tgUser.last_name||""}`.trim(),
    amount: amt, sms, txId, txKey,
    status: "pending",
    ts: serverTimestamp()
  });

  $("depAmount").value = "";
  $("depSms").value    = "";
  toast("✅ ጥያቄዎ ተልኳል! በራስሰር እየተረጋገጠ ነው...");
  loadDepositHistory();
}
window.submitDeposit = submitDeposit;

// Single persistent listener — started once at app init, never re-created
let _depHistStarted = false;

function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function loadDepositHistory() {
  if (_depHistStarted) return; // already listening
  _depHistStarted = true;
  onValue(ref(db, `users/${UID}/transactions`), snap => {
    const container = $("depositHistory");
    if (!container) return;
    container.innerHTML = "";
    if (!snap.exists()) return;
    const txs = [];
    snap.forEach(child => { txs.push({ ...child.val(), key: child.key }); });
    txs.filter(t => t.type === "deposit")
       .sort((a, b) => (b.ts || 0) - (a.ts || 0))
       .slice(0, 8)
       .forEach(t => {
         const el = document.createElement("div");
         const depDate = fmtDate(t.ts);
         el.className = `hist-item hist-dep ${t.status === "pending" ? "hist-pending" : ""}`;
         el.innerHTML = `
           <div class="hist-label">📥 Deposit
             ${depDate ? `<div class="hist-date">${depDate}</div>` : ""}
           </div>
           <div class="hist-right">
             <div class="hist-amount pos">+${t.amount} ETB</div>
             ${t.status === "pending"
               ? `<div class="hist-status">⏳ Pending...</div>`
               : t.status === "cancelled"
               ? `<div class="hist-status" style="color:#ff4444">❌ Cancelled</div>`
               : `<div class="hist-status" style="color:var(--green)">✅ Approved</div>`}
           </div>
         `;
         container.appendChild(el);
       });
  });
}

// ===== WITHDRAW =====
async function submitWithdraw() {
  const phone = $("wdPhone").value.trim();
  const amt   = parseFloat($("wdAmount").value);
  if (!phone || phone.length < 10) { toast("⚠ ትክክለኛ TeleBirr ቁጥር ያስገቡ!"); return; }
  if (!amt || amt < 50)            { toast("⚠ ቢያንስ 50 ETB ያስገቡ!");           return; }
  if (amt > userBalance)           { toast("⚠ በቂ ሂሳብ የለዎትም!");              return; }

  const fee    = +(amt * 0.05).toFixed(2);
  const payout = +(amt - 0).toFixed(2);
  const newBal = +(userBalance - amt).toFixed(2);

  await update(ref(db, `users/${UID}`), { balance: newBal });
  userBalance = newBal;
  $("topBalance").textContent    = userBalance.toFixed(2);
  $("menuBalance").textContent   = userBalance.toFixed(2);
  $("withdrawBalanceDisplay").textContent = userBalance.toFixed(2) + " ETB";

  const txRef = push(ref(db, `users/${UID}/transactions`));
  await set(txRef, { type:"withdraw", status:"pending", amount:amt, fee, payout, phone, uid:UID, username: tgUser.username||myUsername, ts: serverTimestamp() });

  const adminRef = push(ref(db, `withdrawRequests`));
  await set(adminRef, { uid:UID, username: tgUser.username||myUsername, name:`${tgUser.first_name||""} ${tgUser.last_name||""}`.trim(), amount:amt, fee, payout, phone, status:"pending", ts: serverTimestamp() });

  $("wdPhone").value = ""; $("wdAmount").value = "";
  toast(`✅ ጥያቄዎ ተልኳል! ${payout} ETB ወደ ${phone} ይደርሳል`);
}
window.submitWithdraw = submitWithdraw;

function loadWithdrawHistory() {
  const container = $("withdrawHistory");
  if (!container) return;
  onValue(ref(db, `users/${UID}/transactions`), snap => {
    container.innerHTML = "";
    if (!snap.exists()) return;
    const txs = [];
    snap.forEach(child => { txs.push({ ...child.val(), key: child.key }); });
    txs.filter(t => t.type === "withdraw").reverse().slice(0, 8).forEach(t => {
      const el = document.createElement("div");
      el.className = `hist-item hist-bet ${t.status === "pending" ? "hist-pending" : ""}`;
      el.innerHTML = `
        <div class="hist-label">📤 Withdraw → ${t.phone||""}</div>
        <div class="hist-right">
          <div class="hist-amount neg">-${t.amount} ETB</div>
          ${t.status === "pending"
            ? `<div class="hist-status">⏳ Pending...</div>`
            : t.status === "cancelled"
            ? `<div class="hist-status" style="color:#ff4444">❌ Cancelled</div>`
            : `<div class="hist-status" style="color:var(--green)">✅ ተላልፏል</div>`}
        </div>
      `;
      container.appendChild(el);
    });
  });
}
window.loadWithdrawHistory = loadWithdrawHistory;

// ===== FULL HISTORY =====
async function showHistory() {
  showScreen("screen-history");
  const snap = await get(ref(db, `users/${UID}/transactions`));
  const container = $("fullHistory");
  container.innerHTML = "";
  if (!snap.exists()) {
    container.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:40px;font-family:var(--font-am)">ምንም ግብይት የለም</div>`;
    return;
  }
  const txs = [];
  snap.forEach(child => { txs.push({ ...child.val(), key: child.key }); });
  txs.reverse().forEach(t => {
    const el = document.createElement("div");
    const cls = t.type === "win" ? "hist-win" : t.type === "deposit" ? "hist-dep" : "hist-bet";
    const icon = t.type === "win" ? "🏆" : t.type === "deposit" ? "📥" : t.type === "withdraw" ? "📤" : "🎯";
    const pos = t.type === "win" || t.type === "deposit";
    const dateStr = fmtDate(t.ts);
    // Label and amount logic
    let label, displayAmt, amtClass;
    if (t.type === "win") {
      label = "ድል";
      displayAmt = "+" + t.amount + " ETB";
      amtClass = "pos";
    } else if (t.type === "deposit") {
      label = "Deposit";
      displayAmt = "+" + t.amount + " ETB";
      amtClass = "pos";
    } else if (t.type === "withdraw") {
      label = "Withdraw";
      displayAmt = "-" + t.amount + " ETB";
      amtClass = "neg";
    } else {
      // stake / game entry fee
      label = "ጨዋታ ክፍያ";
      displayAmt = "-" + (t.stake || t.amount) + " ETB";
      amtClass = "neg";
    }
    el.className = `hist-item ${cls}`;
    el.innerHTML = `
      <div class="hist-label">
        ${icon} ${label}${t.stake ? " (" + t.stake + " ETB)" : ""}
        ${dateStr ? `<div class="hist-date">${dateStr}</div>` : ""}
      </div>
      <div class="hist-right">
        <div class="hist-amount ${amtClass}">${displayAmt}</div>
        ${t.status === "pending" ? `<div class="hist-status">⏳ Pending</div>` : ""}
      </div>
    `;
    container.appendChild(el);
  });
}
window.showHistory = showHistory;

// ===== CONFETTI =====
function launchConfetti() {
  const wrap = $("confettiWrap");
  wrap.innerHTML = "";
  const colors = ["#ffd700","#ff9500","#ff4444","#00e676","#00e5ff","#e040fb","#0061ff"];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement("div");
    p.className = "conf-piece";
    p.style.cssText = `
      left: ${Math.random()*100}%;
      background: ${colors[Math.floor(Math.random()*colors.length)]};
      width: ${Math.random()*8+5}px;
      height: ${Math.random()*8+5}px;
      border-radius: ${Math.random()>.5 ? "50%" : "2px"};
      animation-duration: ${Math.random()*2+1.5}s;
      animation-delay: ${Math.random()*0.8}s;
    `;
    wrap.appendChild(p);
  }
  setTimeout(() => wrap.innerHTML = "", 4000);
}

// ===== INIT APP =====
const ADMIN_ID = "979887945";
const IS_ADMIN = UID === ADMIN_ID;

async function init() {
  buildStakeGrid();
  startCycleEngine();
  await initUser();
  if (IS_ADMIN) {
    showScreen("screen-admin");
    loadAdminPanel();
  } else {
    showScreen("screen-home");
    loadDepositHistory();
    startNotifListener();
  }
}

init();


// ===== ADMIN PANEL =====
// Completely rewritten — no innerHTML, no ID selectors, pure DOM API

// Helper: treat missing/null/undefined status as "pending"
function isPend(st) {
  return !st || st === "pending";
}

// Track if listeners already attached (prevent duplicates)
let _adminListenersStarted = false;

function loadAdminPanel() {
  if (_adminListenersStarted) return;
  _adminListenersStarted = true;
  _listenStats();
  _listenDeposits();
  _listenWithdraws();
  _listenUsers();
  loadBotSettings();
}

// ── Tab switching ──────────────────────────────────────────────
function adminTab(tab) {
  const tabs   = ["deposit", "withdraw", "users", "settings"];
  const panels = {
    deposit:  document.getElementById("adminPanelDeposit"),
    withdraw: document.getElementById("adminPanelWithdraw"),
    users:    document.getElementById("adminPanelUsers"),
    settings: document.getElementById("adminPanelSettings")
  };
  const btns = {
    deposit:  document.getElementById("tabDeposit"),
    withdraw: document.getElementById("tabWithdraw"),
    users:    document.getElementById("tabUsers"),
    settings: document.getElementById("tabSettings")
  };
  tabs.forEach(t => {
    if (panels[t]) panels[t].style.display = (t === tab) ? "block" : "none";
    if (btns[t])   btns[t].classList.toggle("active", t === tab);
  });
  // settings tab ሲከፈት fresh load
  if (tab === "settings") loadBotSettings();
}
window.adminTab = adminTab;

// ── Bot Settings (Firebase botSettings/) ──────────────────────
const BOT_SETTINGS_DEFAULTS = {
  startPhotoUrl: "https://i.ibb.co/W4nzSG8v/1772942535161.png",
  startCaption:  "🔥FIRST DEPOSIT 50% BONUS🔥",
  depositName:   "Getachew Abera",
  depositPhone:  "0990633294"
};

async function loadBotSettings() {
  const snap = await get(ref(db, "botSettings"));
  const cfg  = snap.exists() ? snap.val() : {};
  const merged = { ...BOT_SETTINGS_DEFAULTS, ...cfg };

  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setVal("settingDepositName",   merged.depositName);
  setVal("settingDepositPhone",  merged.depositPhone);
  // First deposit bonus
  const bonusEl = document.getElementById("settingBonusEnabled");
  if (bonusEl) bonusEl.checked = merged.firstDepositBonus === true;
  const pctEl = document.getElementById("settingBonusPercent");
  if (pctEl) pctEl.value = merged.firstDepositBonusPct || 50;
  _updateBonusPreview();
  setVal("settingStartPhotoUrl", merged.startPhotoUrl);
  setVal("settingStartCaption",  merged.startCaption);
}

async function saveDepositSettings() {
  const name  = document.getElementById("settingDepositName")?.value.trim();
  const phone = document.getElementById("settingDepositPhone")?.value.trim();
  if (!name || !phone) { toast("⚠ ስም እና ቁጥር ያስፈልጋሉ"); return; }
  try {
    // set() ን ጠቀምን — botSettings node ን ሙሉ ለሙሉ ይፈጥራል ካልሰነ
    const settingsRef = ref(db, "botSettings");
    const snap = await get(settingsRef);
    const current = snap.exists() ? snap.val() : {};
    await set(settingsRef, {
      ...current,
      depositName:  name,
      depositPhone: phone
    });
    toast("✅ TeleBirr account ተዘምኗል!");
    console.log("[settings] saved depositName="+name+" depositPhone="+phone);
  } catch(e) {
    console.error("[settings] save error:", e);
    toast("❌ Error: " + e.message);
  }
}
window.saveDepositSettings = saveDepositSettings;

async function saveStartSettings() {
  const photoUrl = document.getElementById("settingStartPhotoUrl")?.value.trim();
  const caption  = document.getElementById("settingStartCaption")?.value.trim();
  if (!photoUrl) { toast("⚠ Photo URL ያስፈልጋል"); return; }
  await update(ref(db, "botSettings"), { startPhotoUrl: photoUrl, startCaption: caption });
  toast("✅ /start ምስልና ፅሁፍ ተዘምኗል!");
}
window.saveStartSettings = saveStartSettings;

function _updateBonusPreview() {
  const enabled = document.getElementById("settingBonusEnabled")?.checked;
  const pct     = parseFloat(document.getElementById("settingBonusPercent")?.value) || 50;
  const prev    = document.getElementById("bonusPreview");
  if (!prev) return;
  if (!enabled) {
    prev.textContent = "❌ Bonus ዝግ ነው";
    prev.style.color = "rgba(255,255,255,0.35)";
  } else {
    const ex = 100;
    const gets = (ex + ex * pct / 100).toFixed(0);
    prev.textContent = ex + " ETB deposit → " + gets + " ETB ይቀበላሉ";
    prev.style.color = "#00e676";
  }
}
window._updateBonusPreview = _updateBonusPreview;

async function saveFirstDepositSettings() {
  _updateBonusPreview();
  const enabled = document.getElementById("settingBonusEnabled")?.checked || false;
  const pct     = parseFloat(document.getElementById("settingBonusPercent")?.value) || 50;
  try {
    const settingsRef = ref(db, "botSettings");
    const snap = await get(settingsRef);
    const current = snap.exists() ? snap.val() : {};
    await set(settingsRef, { ...current, firstDepositBonus: enabled, firstDepositBonusPct: pct });
    toast(enabled ? "✅ Bonus " + pct + "% ተቀምጧል!" : "❌ Bonus ተዘግቷል");
  } catch(e) { toast("❌ Error: " + e.message); }
}
window.saveFirstDepositSettings = saveFirstDepositSettings;

// ── Stats counters ─────────────────────────────────────────────
function _listenStats() {
  onValue(ref(db, "depositRequests"), snap => {
    let c = 0;
    if (snap.exists()) snap.forEach(s => { if (isPend(s.val().status)) c++; });
    const el = document.getElementById("adminPendingDep");
    if (el) el.textContent = c;
  });

  onValue(ref(db, "withdrawRequests"), snap => {
    let c = 0;
    if (snap.exists()) snap.forEach(s => { if (isPend(s.val().status)) c++; });
    const el = document.getElementById("adminPendingWd");
    if (el) el.textContent = c;
  });

  onValue(ref(db, "users"), snap => {
    const el = document.getElementById("adminTotalUsers");
    if (el) el.textContent = snap.exists() ? Object.keys(snap.val()).length : 0;
  });
}

// ── Build a card using pure DOM (no innerHTML, no ID selectors) ─
function _buildCard(cardClass, rows) {
  // rows = array of {type, content}
  // type: "header" | "meta" | "actions"
  const card = document.createElement("div");
  card.className = "admin-card " + cardClass;

  rows.forEach(row => {
    const rowEl = document.createElement("div");
    rowEl.className = "ac-row" + (row.type === "meta" ? " ac-meta" : row.type === "actions" ? " ac-actions" : "");
    row.content(rowEl);
    card.appendChild(rowEl);
  });

  return card;
}

function _el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function _statusBadge(status) {
  const badge = _el("span", "ac-status");
  if (isPend(status)) {
    badge.className += " st-pending";
    badge.textContent = "⏳ Pending";
  } else if (status === "approved") {
    badge.className += " st-approved";
    badge.textContent = "✅ Approved";
  } else {
    badge.className += " st-cancelled";
    badge.textContent = "❌ Cancelled";
  }
  return badge;
}

function _btn(label, cls, onClick) {
  const b = _el("button", "ac-btn " + cls, label);
  b.addEventListener("click", onClick);
  return b;
}

// ── Deposits ───────────────────────────────────────────────────
function _makeDepCard(item) {
  const pend  = isPend(item.status);
  const cls   = pend ? "acard-pending" : item.status === "approved" ? "acard-approved" : "acard-cancelled";
  const card  = document.createElement("div");
  card.className = "admin-card " + cls;

  // Row 1: user info + amount
  const row1 = document.createElement("div");
  row1.className = "ac-row";

  // Mini avatar (async load from firebase)
  const depAv = document.createElement("div");
  depAv.className = "ac-mini-avatar";
  depAv.textContent = (item.username?.[0] || "?").toUpperCase();
  depAv.style.cursor = "pointer";
  depAv.addEventListener("click", () => openUserProfile(item.uid));
  get(ref(db, "users/" + item.uid + "/photo_url")).then(ps => {
    if (ps.exists() && ps.val()) _setAvatar(depAv, ps.val(), item.username);
  });

  const userDiv  = _el("div", "ac-user");
  userDiv.style.cursor = "pointer";
  userDiv.appendChild(_el("div", "ac-name", "@" + (item.username || "unknown")));
  userDiv.appendChild(_el("div", "ac-uid",  "ID: " + item.uid));
  userDiv.addEventListener("click", () => openUserProfile(item.uid));
  row1.appendChild(depAv);
  row1.appendChild(userDiv);
  row1.appendChild(_el("div", "ac-amount pos", "+" + item.amount + " ETB"));
  card.appendChild(row1);

  // Row 2: SMS + status badge + auto/manual label
  const row2 = document.createElement("div");
  row2.className = "ac-row ac-meta";
  const smsSpan = _el("span", null, "📱 SMS: ");
  const smsBold = _el("b", null, item.sms || "—");
  smsSpan.appendChild(smsBold);
  row2.appendChild(smsSpan);

  // Status badge — auto vs manual
  const statusWrap = document.createElement("div");
  statusWrap.style.cssText = "display:flex;align-items:center;gap:6px;flex-shrink:0";
  statusWrap.appendChild(_statusBadge(item.status));
  if (item.status === "approved") {
    const byBadge = document.createElement("span");
    byBadge.style.cssText = "font-size:0.6rem;padding:2px 7px;border-radius:8px;font-weight:700;";
    if (item.approvedBy === "auto") {
      byBadge.textContent = "🤖 AUTO";
      byBadge.style.background = "rgba(0,230,118,0.15)";
      byBadge.style.color = "#00e676";
    } else {
      byBadge.textContent = "👤 MANUAL";
      byBadge.style.background = "rgba(100,181,246,0.15)";
      byBadge.style.color = "#64b5f6";
    }
    statusWrap.appendChild(byBadge);
  }
  if (item.txId) {
    const txEl = _el("span", null, "TX: " + item.txId);
    txEl.style.cssText = "font-size:0.58rem;color:rgba(255,255,255,0.35);display:block;margin-top:2px;";
    row2.appendChild(txEl);
  }
  row2.appendChild(statusWrap);
  card.appendChild(row2);

  // Row 3: Action buttons (only if pending)
  if (pend) {
    const row3 = document.createElement("div");
    row3.className = "ac-actions";
    row3.appendChild(_btn("✅ Approve", "ac-approve", () => _approveDeposit(item.key, item.uid, item.amount)));
    row3.appendChild(_btn("❌ Cancel",  "ac-cancel",  () => _cancelDeposit(item.key)));
    card.appendChild(row3);
  }

  return card;
}

function _listenDeposits() {
  onValue(ref(db, "depositRequests"), snap => {
    const list = document.getElementById("adminDepositList");
    if (!list) return;

    // Clear
    while (list.firstChild) list.removeChild(list.firstChild);

    if (!snap.exists()) {
      list.appendChild(_el("div", "admin-empty", "ምንም deposit request የለም"));
      return;
    }

    const items = [];
    snap.forEach(s => {
      const v = s.val();
      items.push({
        key:        s.key,
        uid:        v.uid        || "",
        username:   v.username   || "",
        amount:     v.amount     || 0,
        sms:        v.sms        || "",
        status:     v.status,
        approvedBy: v.approvedBy || "",
        txId:       v.txId       || "",
        ts:         v.ts         || 0
      });
    });

    // Sort: pending first, then newest
    items.sort((a, b) => {
      const pa = isPend(a.status) ? 0 : 1;
      const pb = isPend(b.status) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return b.ts - a.ts;
    });

    items.forEach(item => list.appendChild(_makeDepCard(item)));
  });
}

async function _approveDeposit(key, uid, amount) {
  if (!confirm(amount + " ETB approve ታደርጋለህ?")) return;
  try {
    // bonusAmount ለ bot listener ቀደም ሲሉ ስናውቅ ነው ስለዚህ request ን ዘምነናል
    // ቅድሚያ bonus አስሉ ከዛ request update
    const _userSnapPre = await get(ref(db, "users/" + uid));
    const _userPre     = _userSnapPre.exists() ? _userSnapPre.val() : {};
    const _isFirstPre  = !_userPre.firstDepositDone;
    let _preBonus = 0;
    if (_isFirstPre) {
      const _cfgPre = await get(ref(db, "botSettings"));
      const _cfg    = _cfgPre.exists() ? _cfgPre.val() : {};
      if (_cfg.firstDepositBonus === true) {
        _preBonus = +((amount * (_cfg.firstDepositBonusPct || 50)) / 100).toFixed(2);
      }
    }

    await update(ref(db, "depositRequests/" + key), {
      status:           "approved",
      approvedBy:       UID,
      approvedAt:       serverTimestamp(),
      telegramNotified: false,
      bonusAmount:      _preBonus     // bot listener ይህን ያነባል
    });

    // Update user transaction status
    const txSnap = await get(ref(db, "users/" + uid + "/transactions"));
    if (txSnap.exists()) {
      const upd = {};
      txSnap.forEach(s => {
        const t = s.val();
        if (t.type === "deposit" && isPend(t.status) && t.amount === amount) {
          upd["users/" + uid + "/transactions/" + s.key + "/status"]     = "approved";
          upd["users/" + uid + "/transactions/" + s.key + "/approvedBy"] = UID;
        }
      });
      if (Object.keys(upd).length) await update(ref(db), upd);
    }

    // ── First Deposit Bonus (ቀደም ሲሉ ተሰልቷል — _preBonus) ──
    let creditAmount = amount;
    let bonusAmount  = _preBonus;
    creditAmount     = +( amount + bonusAmount ).toFixed(2);
    if (_isFirstPre) {
      await update(ref(db, "users/" + uid), { firstDepositDone: true });
    }

    // Credit balance
    const balSnap = await get(ref(db, "users/" + uid + "/balance"));
    const cur = balSnap.exists() ? (balSnap.val() || 0) : 0;
    await update(ref(db, "users/" + uid), { balance: +(cur + creditAmount).toFixed(2) });

    // Notification
    const notifMsg = bonusAmount > 0
      ? "✅ " + amount + " ETB deposit ጸድቋል! 🎁 +" + bonusAmount + " ETB bonus ተጨምሯል! ድምር: " + creditAmount + " ETB"
      : "✅ " + amount + " ETB deposit ተረጋግጧል! ሂሳብዎ ተዘምኗል።";
    await set(push(ref(db, "users/" + uid + "/notifications")), {
      from: "Alpha Bingo", message: notifMsg, read: false, ts: serverTimestamp()
    });

    const toastMsg = bonusAmount > 0
      ? "✅ " + amount + " ETB + 🎁 " + bonusAmount + " ETB bonus = " + creditAmount + " ETB"
      : "✅ " + amount + " ETB approved!";
    toast(toastMsg);
  } catch (e) {
    console.error(e);
    toast("❌ Error: " + e.message);
  }
}

async function _cancelDeposit(key) {
  if (!confirm("ይህን deposit ሰርዝ?")) return;
  try {
    const reqSnap = await get(ref(db, "depositRequests/" + key));
    if (!reqSnap.exists()) { toast("⚠ Request not found"); return; }
    const reqData = reqSnap.val();
    const uid = reqData.uid;
    const amount = reqData.amount;
    await update(ref(db, "depositRequests/" + key), { status: "cancelled" });
    if (uid) {
      const txSnap = await get(ref(db, "users/" + uid + "/transactions"));
      if (txSnap.exists()) {
        const upd = {};
        txSnap.forEach(s => {
          const t = s.val();
          if (t.type === "deposit" && isPend(t.status) && t.amount === amount)
            upd["users/" + uid + "/transactions/" + s.key + "/status"] = "cancelled";
        });
        if (Object.keys(upd).length) await update(ref(db), upd);
      }
    }
    toast("❌ Deposit cancelled.");
  } catch (e) {
    toast("❌ Error: " + e.message);
  }
}

// ── Withdrawals ────────────────────────────────────────────────
function _makeWdCard(item) {
  const pend = isPend(item.status);
  const cls  = pend ? "acard-pending" : item.status === "approved" ? "acard-approved" : "acard-cancelled";
  const card = document.createElement("div");
  card.className = "admin-card " + cls;

  // Row 1
  const row1 = document.createElement("div");
  row1.className = "ac-row";

  const wdAv = document.createElement("div");
  wdAv.className = "ac-mini-avatar";
  wdAv.textContent = (item.username?.[0] || "?").toUpperCase();
  wdAv.style.cursor = "pointer";
  wdAv.addEventListener("click", () => openUserProfile(item.uid));
  get(ref(db, "users/" + item.uid + "/photo_url")).then(ps => {
    if (ps.exists() && ps.val()) _setAvatar(wdAv, ps.val(), item.username);
  });

  const userDiv = _el("div", "ac-user");
  userDiv.style.cursor = "pointer";
  userDiv.appendChild(_el("div", "ac-name", "@" + (item.username || "unknown")));
  userDiv.appendChild(_el("div", "ac-uid",  "ID: " + item.uid));
  userDiv.addEventListener("click", () => openUserProfile(item.uid));
  row1.appendChild(wdAv);
  row1.appendChild(userDiv);
  row1.appendChild(_el("div", "ac-amount neg", "-" + item.amount + " ETB"));
  card.appendChild(row1);

  // Row 2
  const row2 = document.createElement("div");
  row2.className = "ac-row ac-meta";
  row2.appendChild(_el("span", null, "📱 " + (item.phone || "—")));
  row2.appendChild(_el("span", null, "💸 " + (item.payout || item.amount) + " ETB"));
  row2.appendChild(_statusBadge(item.status));
  card.appendChild(row2);

  // Row 3
  if (pend) {
    const row3 = document.createElement("div");
    row3.className = "ac-actions";
    row3.appendChild(_btn("✅ Mark Sent", "ac-approve", () => _approveWithdraw(item.key, item.uid, item.amount)));
    row3.appendChild(_btn("❌ Refund",    "ac-cancel",  () => _cancelWithdraw(item.key, item.uid, item.amount)));
    card.appendChild(row3);
  }

  return card;
}

function _listenWithdraws() {
  onValue(ref(db, "withdrawRequests"), snap => {
    const list = document.getElementById("adminWithdrawList");
    if (!list) return;

    while (list.firstChild) list.removeChild(list.firstChild);

    if (!snap.exists()) {
      list.appendChild(_el("div", "admin-empty", "ምንም withdrawal request የለም"));
      return;
    }

    const items = [];
    snap.forEach(s => {
      const v = s.val();
      items.push({
        key:      s.key,
        uid:      v.uid      || "",
        username: v.username || "",
        amount:   v.amount   || 0,
        phone:    v.phone    || "",
        payout:   v.payout   || v.amount || 0,
        status:   v.status,
        ts:       v.ts       || 0
      });
    });

    items.sort((a, b) => {
      const pa = isPend(a.status) ? 0 : 1;
      const pb = isPend(b.status) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return b.ts - a.ts;
    });

    items.forEach(item => list.appendChild(_makeWdCard(item)));
  });
}

async function _approveWithdraw(key, uid, amount) {
  if (!confirm(amount + " ETB ተልኳል ብለህ ታረጋግጣለህ?")) return;
  try {
    await update(ref(db, "withdrawRequests/" + key), { status: "approved" });
    const txSnap = await get(ref(db, "users/" + uid + "/transactions"));
    if (txSnap.exists()) {
      const upd = {};
      txSnap.forEach(s => {
        const t = s.val();
        if (t.type === "withdraw" && isPend(t.status) && t.amount === amount)
          upd["users/" + uid + "/transactions/" + s.key + "/status"] = "approved";
      });
      if (Object.keys(upd).length) await update(ref(db), upd);
    }
    toast("✅ Withdrawal marked as sent!");
  } catch (e) {
    toast("❌ Error: " + e.message);
  }
}

async function _cancelWithdraw(key, uid, amount) {
  if (!confirm("Cancel & " + amount + " ETB refund ታደርጋለህ?")) return;
  try {
    await update(ref(db, "withdrawRequests/" + key), { status: "cancelled" });
    const txSnap = await get(ref(db, "users/" + uid + "/transactions"));
    if (txSnap.exists()) {
      const upd = {};
      txSnap.forEach(s => {
        const t = s.val();
        if (t.type === "withdraw" && isPend(t.status) && t.amount === amount)
          upd["users/" + uid + "/transactions/" + s.key + "/status"] = "cancelled";
      });
      if (Object.keys(upd).length) await update(ref(db), upd);
    }
    // Refund
    const balSnap = await get(ref(db, "users/" + uid + "/balance"));
    const cur = balSnap.exists() ? (balSnap.val() || 0) : 0;
    await update(ref(db, "users/" + uid), { balance: +(cur + amount).toFixed(2) });
    toast("↩ Refunded " + amount + " ETB");
  } catch (e) {
    toast("❌ Error: " + e.message);
  }
}

// ── Users ──────────────────────────────────────────────────────
function _listenUsers() {
  onValue(ref(db, "users"), snap => {
    const list = document.getElementById("adminUserList");
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);

    if (!snap.exists()) {
      list.appendChild(_el("div", "admin-empty", "ምንም user የለም"));
      return;
    }

    const users = [];
    snap.forEach(s => {
      const v = s.val();
      users.push({
        uid:       s.key,
        name:      v.name      || "",
        username:  v.username  || "",
        balance:   v.balance   || 0,
        photo_url: v.photo_url || "",
        createdAt: v.createdAt || 0
      });
    });
    users.sort((a, b) => b.balance - a.balance);

    users.forEach(u => {
      const card = document.createElement("div");
      card.className = "admin-card acard-user";
      card.style.cursor = "pointer";

      const row1 = document.createElement("div");
      row1.className = "ac-row";

      // Mini avatar
      const miniAv = document.createElement("div");
      miniAv.className = "ac-mini-avatar";
      _setAvatar(miniAv, u.photo_url, u.name || u.username);

      const userDiv = _el("div", "ac-user");
      userDiv.appendChild(_el("div", "ac-name", u.name || u.username || "Unknown"));
      userDiv.appendChild(_el("div", "ac-uid", "@" + (u.username || "—") + " · ID: " + u.uid));

      row1.appendChild(miniAv);
      row1.appendChild(userDiv);
      row1.appendChild(_el("div", "ac-amount pos", u.balance.toFixed(2) + " ETB"));
      card.appendChild(row1);

      // Action buttons row
      const row2 = document.createElement("div");
      row2.className = "ac-actions";

      const btnBalance = _btn("💰 Balance", "ac-approve", (e) => {
        e.stopPropagation();
        _adjustBalance(u.uid, u.name || u.username || u.uid, u.balance);
      });
      const btnMsg = _btn("✉️ ሜሴጅ", "ac-cancel", (e) => {
        e.stopPropagation();
        _currentMsgUid      = u.uid;
        _currentMsgUsername = u.name || u.username || u.uid;
        openSendMsg();
      });
      btnMsg.style.background = "linear-gradient(135deg,#5500cc,#8833ff)";

      row2.appendChild(btnBalance);
      row2.appendChild(btnMsg);
      card.appendChild(row2);

      // Click card → open profile
      card.addEventListener("click", () => openUserProfile(u.uid));
      list.appendChild(card);
    });
  });
}

async function _adjustBalance(uid, name, cur) {
  const val = prompt(name + "\nአዲስ balance (አሁን: " + cur.toFixed(2) + " ETB):");
  if (val === null) return;
  const nb = parseFloat(val);
  if (isNaN(nb) || nb < 0) { toast("⚠ ትክክለኛ ቁጥር ያስገቡ"); return; }
  try {
    await update(ref(db, "users/" + uid), { balance: nb });
    toast("✅ Balance → " + nb + " ETB");
  } catch (e) {
    toast("❌ Error: " + e.message);
  }
}

// ── Expose for modal buttons ──────────────────────────────────
window.upmAdjustBalance = async function() {
  if (!_currentProfileUid) return;
  const snap = await get(ref(db, "users/" + _currentProfileUid + "/balance"));
  const cur  = snap.exists() ? (snap.val() || 0) : 0;
  const name = document.getElementById("upmName").textContent;
  closeUserProfile();
  await _adjustBalance(_currentProfileUid, name, cur);
};

// ===== USER PROFILE MODAL =====
let _currentProfileUid = null;
let _currentMsgUid     = null;
let _currentMsgUsername = null;

async function openUserProfile(uid) {
  _currentProfileUid  = uid;
  _currentMsgUid      = uid;

  const overlay = document.getElementById("userProfileOverlay");
  const modal   = document.getElementById("userProfileModal");
  overlay.classList.add("active");
  modal.classList.add("active");

  // Reset
  document.getElementById("upmName").textContent     = "Loading...";
  document.getElementById("upmUsername").textContent = "—";
  document.getElementById("upmId").textContent       = "ID: " + uid;
  document.getElementById("upmBalance").textContent  = "…";
  document.getElementById("upmJoined").textContent   = "…";
  document.getElementById("upmDepCount").textContent = "…";
  document.getElementById("upmDepTotal").textContent = "…";
  document.getElementById("upmWdCount").textContent  = "…";
  document.getElementById("upmWdTotal").textContent  = "…";
  document.getElementById("upmGames").textContent    = "…";
  document.getElementById("upmWins").textContent     = "…";
  document.getElementById("upmTxList").innerHTML     = "";

  try {
    const userSnap = await get(ref(db, "users/" + uid));
    if (!userSnap.exists()) { toast("⚠ User not found"); return; }
    const u = userSnap.val();

    const displayName = u.name || u.username || "Unknown";
    _currentMsgUsername = displayName;

    const upmAv = document.getElementById("upmAvatar");
    _setAvatar(upmAv, u.photo_url || "", displayName);
    document.getElementById("upmName").textContent      = displayName;
    document.getElementById("upmUsername").textContent  = "@" + (u.username || "—");
    document.getElementById("upmId").textContent        = "Telegram ID: " + uid;
    document.getElementById("upmBalance").textContent   = (u.balance || 0).toFixed(2);

    // Format join date
    if (u.createdAt) {
      const d = new Date(u.createdAt);
      const p = n => String(n).padStart(2, "0");
      document.getElementById("upmJoined").textContent =
        d.getFullYear() + "/" + p(d.getMonth()+1) + "/" + p(d.getDate()) +
        " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } else {
      document.getElementById("upmJoined").textContent = "—";
    }

    // Transactions
    const txSnap = await get(ref(db, "users/" + uid + "/transactions"));
    let depCount = 0, depTotal = 0, wdCount = 0, wdTotal = 0, games = 0, wins = 0;
    const txList = [];

    if (txSnap.exists()) {
      txSnap.forEach(child => {
        const t = { ...child.val(), key: child.key };
        txList.push(t);
        if (t.type === "deposit")  { depCount++; if (t.status === "approved") depTotal += t.amount || 0; }
        if (t.type === "withdraw") { wdCount++;  wdTotal += t.amount || 0; }
        if (t.type === "stake")    { games++; }
        if (t.type === "win")      { wins++; }
      });
    }

    document.getElementById("upmDepCount").textContent = depCount;
    document.getElementById("upmDepTotal").textContent = depTotal.toFixed(0);
    document.getElementById("upmWdCount").textContent  = wdCount;
    document.getElementById("upmWdTotal").textContent  = wdTotal.toFixed(0);
    document.getElementById("upmGames").textContent    = games;
    document.getElementById("upmWins").textContent     = wins;

    // Render recent transactions
    const txContainer = document.getElementById("upmTxList");
    txContainer.innerHTML = "";
    const recent = [...txList].reverse().slice(0, 15);
    if (recent.length === 0) {
      const empty = _el("div", null, "ምንም ግብይት የለም");
      empty.style.cssText = "text-align:center;color:var(--text-dim);font-family:var(--font-am);padding:20px 0;font-size:0.78rem;";
      txContainer.appendChild(empty);
    }
    recent.forEach(t => {
      const item = document.createElement("div");
      const typeMap = { deposit:"upm-dep", withdraw:"upm-wd", win:"upm-win", stake:"upm-stake" };
      item.className = "upm-tx-item " + (typeMap[t.type] || "");

      const labelMap = { deposit:"📥 Deposit", withdraw:"📤 Withdraw", win:"🏆 ድል", stake:"🎯 ክፍያ" };
      const amtMap   = {
        deposit: "+" + (t.amount||0) + " ETB",
        withdraw: "-" + (t.amount||0) + " ETB",
        win: "+" + (t.amount||0) + " ETB",
        stake: "-" + (t.stake||t.amount||0) + " ETB"
      };
      const amtColor = { deposit:"var(--lime)", withdraw:"var(--amber)", win:"#ffb700", stake:"var(--red)" };

      const left = document.createElement("div");
      const lbl = _el("div", "upm-tx-label", labelMap[t.type] || t.type);
      left.appendChild(lbl);
      if (t.ts) {
        const d = new Date(t.ts);
        const p = n => String(n).padStart(2,"0");
        const dateLbl = _el("div", "upm-tx-date",
          d.getFullYear()+"/"+p(d.getMonth()+1)+"/"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes()));
        left.appendChild(dateLbl);
      }
      item.appendChild(left);

      const right = document.createElement("div");
      right.style.textAlign = "right";
      const amt = _el("div", "upm-tx-amt", amtMap[t.type] || "");
      amt.style.color = amtColor[t.type] || "#fff";
      right.appendChild(amt);

      // Status label — auto vs manual vs pending vs rejected
      if (t.type === "deposit") {
        let statusEl;
        if (t.status === "pending") {
          statusEl = _el("div", "upm-tx-status", "⏳ Pending");
          statusEl.style.color = "#ffa500";
        } else if (t.status === "manual_review") {
          statusEl = _el("div", "upm-tx-status", "🔍 Manual review");
          statusEl.style.color = "#ffa500";
        } else if (t.status === "rejected") {
          statusEl = _el("div", "upm-tx-status", "❌ Rejected");
          statusEl.style.color = "#ff4444";
        } else if (t.status === "approved") {
          // approvedBy: "auto" = server, anything else = admin manually
          if (t.approvedBy === "auto") {
            statusEl = _el("div", "upm-tx-status", "🤖 Auto approved");
            statusEl.style.color = "#00e676";
          } else {
            statusEl = _el("div", "upm-tx-status", "👤 Manual approved");
            statusEl.style.color = "#64b5f6";
          }
        }
        if (statusEl) right.appendChild(statusEl);

        // txId ካለ ያሳይ
        if (t.txId) {
          const txEl = _el("div", "upm-tx-date", "TX: " + t.txId);
          txEl.style.color = "rgba(255,255,255,0.4)";
          right.appendChild(txEl);
        }
      } else {
        if (t.status === "pending") right.appendChild(_el("div", "upm-tx-status", "⏳ Pending"));
      }

      item.appendChild(right);
      txContainer.appendChild(item);
    });
  } catch(e) {
    console.error("[openUserProfile]", e);
    toast("❌ Error loading profile");
  }
}
window.openUserProfile = openUserProfile;

function closeUserProfile() {
  document.getElementById("userProfileOverlay").classList.remove("active");
  document.getElementById("userProfileModal").classList.remove("active");
}
window.closeUserProfile = closeUserProfile;

// ===== SEND MESSAGE =====
function openSendMsg() {
  if (!_currentMsgUid) return;
  document.getElementById("smmTo").textContent = "ወደ: " + (_currentMsgUsername || _currentMsgUid);
  document.getElementById("smmText").value = "";
  document.getElementById("sendMsgOverlay").classList.add("active");
  document.getElementById("sendMsgModal").classList.add("active");
  setTimeout(() => document.getElementById("smmText").focus(), 200);
}
window.openSendMsg = openSendMsg;

function closeSendMsg() {
  document.getElementById("sendMsgOverlay").classList.remove("active");
  document.getElementById("sendMsgModal").classList.remove("active");
}
window.closeSendMsg = closeSendMsg;

async function sendAdminMsg() {
  const text = document.getElementById("smmText").value.trim();
  if (!text) { toast("⚠ ሜሴጁን ይጻፉ"); return; }
  if (!_currentMsgUid) return;

  try {
    const msgRef = push(ref(db, "users/" + _currentMsgUid + "/notifications"));
    await set(msgRef, {
      from:    "Alpha Bingo Admin",
      message: text,
      read:    false,
      ts:      serverTimestamp()
    });
    toast("✅ ሜሴጅ ተላልፏል!");
    closeSendMsg();
  } catch(e) {
    toast("❌ Error: " + e.message);
  }
}
window.sendAdminMsg = sendAdminMsg;

// ===== NOTIFICATION INBOX (for regular users) =====
function openNotifInbox() {
  document.getElementById("notifOverlay").classList.add("active");
  document.getElementById("notifModal").classList.add("active");
  markNotifsRead();
}
window.openNotifInbox = openNotifInbox;

function closeNotifInbox() {
  document.getElementById("notifOverlay").classList.remove("active");
  document.getElementById("notifModal").classList.remove("active");
}
window.closeNotifInbox = closeNotifInbox;

function startNotifListener() {
  onValue(ref(db, "users/" + UID + "/notifications"), snap => {
    const list  = document.getElementById("notifList");
    const badge = document.getElementById("notifBadge");
    if (!list) return;

    if (!snap.exists()) {
      list.innerHTML = "<div class='notif-empty'>ምንም ማሳወቂያ የለም</div>";
      badge.style.display = "none";
      return;
    }

    const notifs = [];
    snap.forEach(child => notifs.push({ key: child.key, ...child.val() }));
    notifs.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    // Update badge
    const unread = notifs.filter(n => !n.read).length;
    if (unread > 0) {
      badge.textContent   = unread > 9 ? "9+" : unread;
      badge.style.display = "flex";
    } else {
      badge.style.display = "none";
    }

    // Build keyed map of existing DOM items to avoid full re-render (prevents blink)
    const existing = {};
    list.querySelectorAll(".notif-item[data-key]").forEach(el => {
      existing[el.dataset.key] = el;
    });

    // Remove "empty" placeholder if present
    list.querySelectorAll(".notif-empty").forEach(el => el.remove());

    // Insert or update each notification without destroying existing elements
    notifs.forEach((n, idx) => {
      let item = existing[n.key];
      if (!item) {
        item = document.createElement("div");
        item.dataset.key = n.key;
        const from = _el("div", "notif-item-from", n.from || "Admin");
        const msg  = _el("div", "notif-item-msg",  n.message || "");
        item.appendChild(from);
        item.appendChild(msg);
        if (n.ts) {
          const d = new Date(n.ts);
          const p = x => String(x).padStart(2,"0");
          item.appendChild(_el("div", "notif-item-time",
            d.getFullYear()+"/"+p(d.getMonth()+1)+"/"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())));
        }
        // Animate only newly added items
        item.classList.add("notif-new");
        setTimeout(() => item.classList.remove("notif-new"), 300);
      }
      // Always sync read/unread class (no re-render = no blink)
      item.className = "notif-item" + (!n.read ? " notif-unread" : "");
      // Maintain sort order
      if (list.children[idx] !== item) list.insertBefore(item, list.children[idx] || null);
    });

    // Remove stale items no longer in snapshot
    const currentKeys = new Set(notifs.map(n => n.key));
    Object.keys(existing).forEach(k => {
      if (!currentKeys.has(k)) existing[k].remove();
    });
  });
}

async function markNotifsRead() {
  const snap = await get(ref(db, "users/" + UID + "/notifications"));
  if (!snap.exists()) return;
  const upd = {};
  snap.forEach(child => {
    if (!child.val().read) upd["users/" + UID + "/notifications/" + child.key + "/read"] = true;
  });
  if (Object.keys(upd).length) await update(ref(db), upd);
}
// (CSS injected inline for settings panel)
