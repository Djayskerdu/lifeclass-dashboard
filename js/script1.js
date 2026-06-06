// ╔═══════════════════════════════════════════════════════════╗
// ║  STEP 1 — PASTE YOUR GAS WEB APP URL BELOW               ║
// ╚═══════════════════════════════════════════════════════════╝
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxupanMI7sWZ1oZz1BZ6ZnZ4mGXBZaXCRyr6YnXmXdShVNfbYbKnHHc_qzX8MWHugV6/exec';

// ─── QR SECURITY TOKEN ───────────────────────────────────────
const QR_SECRET = 'LC2024-DAVAOCHURCH-8X';
const QR_PREFIX = `LIFECLASS_APP:${QR_SECRET}:`;

// ═══════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function apiGet(action, params = "") {
  const url = `${GAS_URL}?action=${action}${params}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for action=${action}`);
  return await res.json();
}

async function apiPost(payload) {
  // text/plain avoids CORS preflight that Google Apps Script rejects
  const res = await fetchWithTimeout(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ═══════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════
let APP = {
  students: [],
  faculty: [],
  lessons: [],
  payments: [],
  attendance: [],
  facultyAttendance: [],
  credits: [],
  qrScans: [],
  tableGuides: [],
  settings: {},
  currentScreen: 's-portal',
  selectedReason: 'Attendance',
  currentWeek: 1,
  totalFee: 500
};

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  loadAllData();
  initClock();
  updateSyncStatus(false);
});

// ═══════════════════════════════════════════
// LOAD ALL DATA
// ═══════════════════════════════════════════
function safeData(settled) {
  if (settled.status === 'rejected') {
    console.warn('API call failed:', settled.reason);
    return [];
  }
  return settled.value?.data || [];
}

async function loadAllData() {
  updateSyncStatus(false);
  const results = await Promise.allSettled([
    apiGet('students'),
    apiGet('faculty'),
    apiGet('credits'),
    apiGet('payments'),
    apiGet('studentAttendance'),
    apiGet('facultyAttendance'),
    apiGet('lessonWeeks'),
    apiGet('qrscans'),
    apiGet('tableGuides'),
    apiGet('settings'),
    apiGet('makeups')
  ]);

  APP.students          = safeData(results[0]);
  APP.faculty           = safeData(results[1]);
  APP.credits           = safeData(results[2]);
  APP.payments          = safeData(results[3]);
  APP.attendance        = safeData(results[4]);
  APP.facultyAttendance = safeData(results[5]);
  APP.lessons           = safeData(results[6]);
  APP.qrScans           = safeData(results[7]);
  APP.tableGuides       = safeData(results[8]);
  APP.makeups           = safeData(results[10]);

  const settingsData = safeData(results[9]);
  if (settingsData.length) {
    settingsData.forEach(row => { APP.settings[row['Setting']] = row['Value']; });
    APP.currentWeek = Number(APP.settings['Current Week'] || 1);
    APP.totalFee    = Number(APP.settings['Total Class Fee'] || 500);
  }

  const failCount = results.filter(r => r.status === 'rejected').length;

  populateCreditStudentSelect();
  populatePayStudentSelect();
  populateWeekDropdowns();
  updateAdminHomeStats();
  updateFacultyHome();
  renderRecordStats();
  renderBalancesSummary();
  refreshCurrentScreen();

  if (failCount === 10) {
    updateSyncStatus(false, 'Cannot reach server — check GAS_URL');
    showConnectionError();
  } else if (failCount > 0) {
    updateSyncStatus(false, failCount + ' source(s) failed to load');
  } else {
    updateSyncStatus(true);
  }
}

function showConnectionError() {
  const el = document.getElementById('sync-label-portal');
  if (el) {
    el.innerHTML = '⚠️ <strong>Not connected.</strong> Set GAS_URL in script1.js, then redeploy.';
    el.style.color = '#c0392b';
    el.style.fontSize = '12px';
  }
}

// ═══════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════
function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(20px)';
  }, duration);
}

// ═══════════════════════════════════════════
// REASON SELECTOR
// ═══════════════════════════════════════════
function selectReason(btn, reason) {
  const grid = btn.closest('.reason-grid');
  if (grid) grid.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  APP.selectedReason = reason;

  const creditOther = document.getElementById('credit-other-wrap');
  if (creditOther) creditOther.style.display = (reason === '__other__' && btn.closest('#s-add-credit')) ? '' : 'none';
  const modalOther = document.getElementById('modal-other-wrap');
  if (modalOther) modalOther.style.display = (reason === '__other__' && btn.closest('#modal-table-credit')) ? '' : 'none';
}

// ═══════════════════════════════════════════
// POPULATE SELECTS
// ═══════════════════════════════════════════
function populateCreditStudentSelect() {
  const sel = document.getElementById('credit-student-sel');
  if (!sel) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  sel.innerHTML = filtered.map(s =>
    `<option value="${s["Student ID"]}">${s["Full Name"]}</option>`
  ).join('');
}

// ═══════════════════════════════════════════
// REFRESH CURRENT SCREEN
// ═══════════════════════════════════════════
function refreshCurrentScreen() {
  const id = APP.currentScreen;
  if (id === 's-faculty-home')  updateFacultyHome();
  if (id === 's-f-lessons')     renderWeeks('f');
  if (id === 's-f-students')    renderFStudents();
  if (id === 's-f-payment')     renderFPayment();
  if (id === 's-f-credits')     renderFCredits();
  if (id === 's-admin-home')    updateAdminHomeStats();
  if (id === 's-a-student-att') renderAStudentAtt();
  if (id === 's-a-faculty-att') renderAFacultyAtt();
  if (id === 's-a-makeup')      renderMakeup();
  if (id === 's-a-dropped')     renderDroppedStudents();
  if (id === 's-a-tables')      renderATables();
  if (id === 's-a-leaderboard') switchLeaderboardTab('students');
  if (id === 's-record-home')   renderRecordStats();
  if (id === 's-r-qr')          { switchQRTab('scan'); }
  if (id === 's-r-attendance')  switchAttTab('students');
  if (id === 's-r-payment')     populatePayStudentSelect();
  if (id === 's-r-balances')    { renderBalances(); renderBalancesSummary(); }
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  APP.currentScreen = id;

  if (id === 's-faculty-home')  updateFacultyHome();
  if (id === 's-f-lessons')     renderWeeks('f');
  if (id === 's-f-students')    renderFStudents();
  if (id === 's-f-payment')     renderFPayment();
  if (id === 's-f-credits')     renderFCredits();
  if (id === 's-admin-home')    updateAdminHomeStats();
  if (id === 's-a-student-att') renderAStudentAtt();
  if (id === 's-a-faculty-att') renderAFacultyAtt();
  if (id === 's-a-makeup')      renderMakeup();
  if (id === 's-a-dropped')     renderDroppedStudents();
  if (id === 's-a-tables')      renderATables();
  if (id === 's-a-leaderboard') switchLeaderboardTab('students');
  if (id === 's-record-home')   renderRecordStats();
  if (id === 's-r-qr')          { switchQRTab('scan'); }
  if (id === 's-r-attendance')  switchAttTab('students');
  if (id === 's-r-payment')     populatePayStudentSelect();
  if (id === 's-r-balances')    { renderBalances(); renderBalancesSummary(); }
  if (id === 's-add-credit')   populateCreditStudentSelect();
}

// ═══════════════════════════════════════════
// WEEK LESSONS
// ═══════════════════════════════════════════
function renderWeeks(prefix) {
  const grid = document.getElementById(`week-grid-${prefix}`);
  if (!grid) return;
  if (!APP.lessons.length) {
    grid.innerHTML = '<p style="padding:16px;color:var(--gray)">No lessons found.</p>';
    return;
  }
  grid.innerHTML = APP.lessons.map(l => `
    <div class="week-card" style="cursor:pointer;border:1.5px solid var(--border);border-radius:12px;padding:14px;background:#fff;transition:box-shadow 0.15s" onclick="showLessonDetail(${l['Week No']},'${prefix}')" onmouseover="this.style.boxShadow='0 2px 12px rgba(0,0,0,0.10)'" onmouseout="this.style.boxShadow='none'">
      <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:2px">WEEK ${l["Week No"]}</div>
      <strong style="font-size:14px;color:var(--text1)">${l["Lesson Title"] || ""}</strong>
      <div style="margin-top:6px;font-size:11px;color:var(--text3)">${l["Status"] || ""}</div>
    </div>
  `).join('');
}

function showLessonDetail(weekNo, prefix) {
  const lesson = APP.lessons.find(l => String(l["Week No"]) === String(weekNo));
  if (!lesson) return;

  const titleEl = document.getElementById('lesson-detail-title');
  const bodyEl  = document.getElementById('lesson-detail-body');

  if (titleEl) titleEl.textContent = `Week ${lesson["Week No"]}`;
  if (bodyEl) bodyEl.innerHTML = `
    <div class="card" style="margin-bottom:12px;background:linear-gradient(135deg,var(--navy),var(--navy-light));padding:18px">
      <div style="font-size:11px;color:rgba(255,255,255,0.65);font-weight:600;margin-bottom:4px">LESSON TITLE</div>
      <div style="font-size:18px;font-weight:700;color:#fff;font-family:var(--font-head)">${lesson["Lesson Title"] || "—"}</div>
    </div>
    <div class="card" style="margin-bottom:12px;padding:18px">
      <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:8px">LESSON CONTENT</div>
      <div style="font-size:14px;color:var(--text1);line-height:1.6">${lesson["Lesson Content"] || "<span style=\'color:var(--text3)\'>No content added yet.</span>"}</div>
    </div>
    <div style="display:flex;gap:10px">
      <div class="card" style="flex:1;padding:14px;text-align:center">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">DATE RELEASED</div>
        <div style="font-size:13px;font-weight:600;color:var(--text1)">${lesson["Date Released"] ? new Date(lesson["Date Released"]).toLocaleDateString() : "—"}</div>
      </div>
      <div class="card" style="flex:1;padding:14px;text-align:center">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">STATUS</div>
        <div style="font-size:13px;font-weight:600;color:${lesson["Status"] === "Released" ? "var(--green)" : "var(--text3)"}">${lesson["Status"] || "—"}</div>
      </div>
    </div>
  `;

  APP._lessonDetailPrefix = prefix;
  go('s-f-lesson-detail');
}

// ═══════════════════════════════════════════
// FACULTY — STUDENTS LIST
// ═══════════════════════════════════════════
function renderFStudents() {
  const list = document.getElementById('f-students-list');
  if (!list) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const week = document.getElementById('f-week-filter')?.value || APP.currentWeek;
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    list.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }

  const statusColors = {
    present: { bg: '#e8f5ee', color: '#2d6a4f', label: 'Present' },
    late:    { bg: '#fff5e0', color: '#c9960c', label: 'Late'    },
    absent:  { bg: '#fdecea', color: '#e53935', label: 'Absent'  },
  };

  list.innerHTML = filtered.map(s => {
    const att = APP.attendance.find(a =>
      String(a["Student ID"]) === String(s["Student ID"]) &&
      String(a["Week No"]) === String(week)
    );
    const rawStatus = (att?.["Attendance Status"] || att?.["Status"] || (att ? "present" : "absent")).toLowerCase();
    const key = rawStatus.includes("late") ? "late" : rawStatus.includes("present") ? "present" : "absent";
    const { bg, color, label } = statusColors[key];
    return `
      <div class="row" style="align-items:center">
        <div><strong>${s["Full Name"]}</strong><br><small>Table ${s["Table No"]}</small></div>
        <div style="background:${bg};color:${color};font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;white-space:nowrap">${label}</div>
      </div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// CREDIT CALCULATION
// ═══════════════════════════════════════════
function getStudentCredits(studentId) {
  return APP.credits
    .filter(c => String(c["Student ID"]) === String(studentId))
    .reduce((sum, c) => sum + Number(c["Credits Added"] || 0), 0);
}

// ═══════════════════════════════════════════
// PAYMENT CALCULATION
// ═══════════════════════════════════════════
function getStudentPayment(studentId) {
  const payments = APP.payments.filter(p => String(p["Student ID"]) === String(studentId));
  if (!payments.length) return { paid: 0, balance: APP.totalFee, status: "Unpaid" };
  const paid = payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
  const balance = APP.totalFee - paid;
  return { paid, balance, status: balance <= 0 ? "Paid" : "Partial" };
}

// ═══════════════════════════════════════════
// FACULTY — PAYMENT LIST
// ═══════════════════════════════════════════
function renderFPayment() {
  const el = document.getElementById('f-payment-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }
  el.innerHTML = filtered.map(s => {
    const pay = getStudentPayment(s["Student ID"]);
    return `
      <div class="row">
        <div>
          <strong>${s["Full Name"]}</strong><br>
          <small>₱${pay.paid.toLocaleString()} paid · ₱${pay.balance.toLocaleString()} balance</small>
        </div>
        <div>${pay.status}</div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// FACULTY — CREDITS LEADERBOARD
// ═══════════════════════════════════════════
function renderFCredits() {
  const el = document.getElementById('f-credits-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const sorted = [...filtered].sort(
    (a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"])
  );
  el.innerHTML = sorted.map((s, i) => `
    <div class="row">
      <div><strong>#${i + 1} ${s["Full Name"]}</strong><br><small>Table ${s["Table No"]}</small></div>
      <div>${getStudentCredits(s["Student ID"])} LC</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No credits yet.</p>';
}

// ═══════════════════════════════════════════
// ADD CREDIT (Faculty)
// ═══════════════════════════════════════════
async function doAddCredit() {
  const sel = document.getElementById('credit-student-sel');
  const studentId = sel ? sel.value : null;
  const amountEl = document.getElementById('credit-amount');
  const amount = parseInt(amountEl ? amountEl.value : 0);

  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Please select a student'); return; }
  if (!amount || amount < 1) { showToast('⚠️ Enter a valid credit amount'); return; }

  const rawReason = APP.selectedReason || 'Attendance';
  const reason = rawReason === '__other__'
    ? (document.getElementById('credit-other-text')?.value?.trim() || 'Other')
    : rawReason;

  try {
    const btn = document.querySelector('#s-add-credit .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    await apiPost({
      action: "addCredit",
      studentId: student["Student ID"],
      studentName: student["Full Name"],
      tableNo: student["Table No"],
      weekNo: APP.currentWeek,
      reason,
      creditsAdded: amount,
      addedBy: APP.currentFaculty?.["Full Name"] || "Faculty"
    });

    showToast(`✅ ${amount} LC added to ${student["Full Name"]}`);
    if (amountEl) amountEl.value = 5;
    await loadAllData();
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to save'));
    console.error('doAddCredit error:', err);
  } finally {
    const btn = document.querySelector('#s-add-credit .btn-primary');
    if (btn) { btn.disabled = false; btn.textContent = 'Add Credits'; }
  }
}

// ═══════════════════════════════════════════
// ADMIN — STUDENT ATTENDANCE
// ═══════════════════════════════════════════
function renderAStudentAtt() {
  const el = document.getElementById('a-att-list');
  const week = document.getElementById('a-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.attendance.filter(a => String(a["Week No"]) === String(week));
  if (!weekAtt.length) {
    el.innerHTML = `<p style="padding:16px;color:var(--gray)">No attendance records for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = weekAtt.map(a => `
    <div class="row">
      <div>
        <strong>${a["Student Name"] || a["StudentName"] || "—"}</strong><br>
        <small>Table ${a["Table No"] || "—"} · ${a["LG Leader"] || ""}</small>
      </div>
      <div>${a["Attendance Status"] || a["Status"] || "Present"}</div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════
// ADMIN — TABLES VIEW
// ═══════════════════════════════════════════
function renderATables() {
  const grid = document.getElementById('a-table-grid');
  const week = document.getElementById('a-table-week')?.value || APP.currentWeek;
  if (!grid) return;

  const weekAtt = APP.attendance.filter(a => String(a["Week No"]) === String(week));
  const tableMap = {};
  APP.students.forEach(s => {
    const t = String(s["Table No"]);
    if (!tableMap[t]) tableMap[t] = { students: [], present: 0 };
    tableMap[t].students.push(s);
  });
  weekAtt.forEach(a => {
    const t = String(a["Table No"]);
    if (tableMap[t]) tableMap[t].present++;
  });

  const tables = Object.keys(tableMap).sort((a, b) => Number(a) - Number(b));
  if (!tables.length) {
    grid.innerHTML = '<p style="padding:16px;color:var(--gray)">No table data found.</p>';
    return;
  }
  grid.innerHTML = tables.map(t => {
    const totalLC = getTableCredits(t);
    return `
      <div class="card" style="padding:14px;cursor:pointer" onclick="showTableDetail('${t}')">
        <div style="font-family:var(--font-head);font-size:18px;font-weight:700">Table ${t}</div>
        <div style="font-size:12px;color:var(--gray);margin-top:4px">${totalLC} LC Credits</div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// ADMIN — TABLE DETAIL
// ═══════════════════════════════════════════
function showTableDetail(tableNo) {
  go('s-a-table-detail');
  // Store current table so refresh works
  APP._currentTableDetail = tableNo;
  const title       = document.getElementById('a-td-title');
  const stats       = document.getElementById('a-td-stats');
  const presentStat = document.getElementById('a-td-present-stat');
  const list        = document.getElementById('a-td-list');
  if (title) title.textContent = `Table ${tableNo}`;

  // Only active (non-dropped) students
  const students = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const presentThisWeek = APP.attendance.filter(a =>
    String(a["Table No"]) === String(tableNo) && String(a["Week No"]) === String(APP.currentWeek)
  );
  // Table-level credits only (not individual student sum)
  const tableCredits = getTableCredits(tableNo);

  if (presentStat) presentStat.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,var(--green),var(--green-light));border-radius:12px;padding:14px 18px;margin-bottom:12px">
      <div style="font-size:28px;font-family:var(--font-head);font-weight:700;color:#fff">${presentThisWeek.length}<span style="font-size:14px;font-weight:500;opacity:0.7">/${students.length}</span></div>
      <div style="color:rgba(255,255,255,0.85);font-size:13px;font-weight:600">Present — Week ${APP.currentWeek}</div>
    </div>
  `;

  if (stats) stats.innerHTML = `
    <div class="stat-card"><div class="stat-val">${students.length}</div><div class="stat-label">Students</div></div>
    <div class="stat-card"><div class="stat-val">${tableCredits}</div><div class="stat-label">Table LC Credits</div></div>
  `;

  const sorted = [...students].sort((a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"]));
  if (list) list.innerHTML = sorted.map(s => `
    <div class="row">
      <div><strong>${s["Full Name"]}</strong></div>
      <div>${getStudentCredits(s["Student ID"])} LC</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No students in this table.</p>';
}

async function confirmDropStudentFromTable(studentId, studentName) {
  if (!confirm(`Drop ${studentName}? This will remove them from active student lists.`)) return;
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Student not found'); return; }
  try {
    await apiPost({
      action: "updateStudentStatus",
      studentId: student["Student ID"],
      studentName: student["Full Name"],
      status: "Dropped"
    });
    student["Status"] = "Dropped";
    showToast(`✅ ${student["Full Name"]} marked as Dropped`);
    renderDroppedStudents();
    updateAdminHomeStats();
    populateCreditStudentSelect();
    // Refresh table detail in place
    showTableDetail(APP._currentTableDetail);
  } catch (err) {
    console.error('confirmDropStudentFromTable error:', err);
    showToast('❌ Failed to update status');
  }
}

// Get total LC credits for a whole table — table-level only (studentId is blank)
function getTableCredits(tableNo) {
  return APP.credits
    .filter(c => String(c["Table No"]) === String(tableNo) && !c["Student ID"])
    .reduce((sum, c) => sum + Number(c["Credits Added"] || 0), 0);
}

// Get total LC credits for a table summing all student credits in that table
function getTableTotalStudentCredits(tableNo) {
  const students = APP.students.filter(s => String(s["Table No"]) === String(tableNo));
  return students.reduce((sum, s) => sum + getStudentCredits(s["Student ID"]), 0);
}

// ═══════════════════════════════════════════
// ADMIN — LEADERBOARD
// ═══════════════════════════════════════════
function switchLeaderboardTab(tab) {
  const studentList = document.getElementById('a-leaderboard-list');
  const tableList   = document.getElementById('a-table-leaderboard-list');
  const sBtn        = document.getElementById('lb-tab-students');
  const tBtn        = document.getElementById('lb-tab-tables');
  if (tab === 'students') {
    studentList.style.display = ''; tableList.style.display = 'none';
    sBtn.style.background = '#c9960c'; sBtn.style.color = '#fff';
    tBtn.style.background = '#fff';   tBtn.style.color = '#c9960c';
    renderLeaderboard();
  } else {
    studentList.style.display = 'none'; tableList.style.display = '';
    tBtn.style.background = '#c9960c'; tBtn.style.color = '#fff';
    sBtn.style.background = '#fff';    sBtn.style.color = '#c9960c';
    renderTableLeaderboard();
  }
}

function renderLeaderboard() {
  const el = document.getElementById('a-leaderboard-list');
  if (!el) return;
  const sorted = [...APP.students].sort((a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"]));
  const medals = ['🥇','🥈','🥉'];
  el.innerHTML = sorted.map((s, i) => `
    <div class="row">
      <div><strong>${medals[i] || `#${i + 1}`} ${s["Full Name"]}</strong><br><small>Table ${s["Table No"]}</small></div>
      <div>${getStudentCredits(s["Student ID"])} LC</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No students yet.</p>';
}

function renderTableLeaderboard() {
  const el = document.getElementById('a-table-leaderboard-list');
  if (!el) return;
  const tableSet = new Set(APP.students.map(s => String(s["Table No"])));
  const tableMap = {};
  tableSet.forEach(t => {
    tableMap[t] = {
      total: getTableCredits(t),
      count: APP.students.filter(s => String(s["Table No"]) === t).length
    };
  });
  const sorted = Object.keys(tableMap).sort((a, b) => tableMap[b].total - tableMap[a].total);
  const medals = ['🥇','🥈','🥉'];
  el.innerHTML = sorted.map((t, i) => `
    <div class="row">
      <div><strong>${medals[i] || `#${i + 1}`} Table ${t}</strong><br><small>${tableMap[t].count} students</small></div>
      <div>${tableMap[t].total} LC</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No data yet.</p>';
}

// ═══════════════════════════════════════════
// ADMIN — DROPPED STUDENTS
// ═══════════════════════════════════════════
function renderDroppedStudents() {
  const el = document.getElementById('a-dropped-list');
  if (!el) return;
  const dropped = APP.students.filter(s =>
    (s["Status"] || "").toLowerCase() === "dropped"
  );
  if (!dropped.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No dropped students found.</p>';
    return;
  }

  // Group by table
  const byTable = {};
  dropped.forEach(s => {
    const t = String(s["Table No"] || "—");
    if (!byTable[t]) byTable[t] = [];
    byTable[t].push(s);
  });

  const tables = Object.keys(byTable).sort((a, b) => Number(a) - Number(b));
  el.innerHTML = tables.map(t => `
    <div style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--text3);letter-spacing:0.05em;padding:10px 16px 4px">TABLE ${t}</div>
      ${byTable[t].map(s => `
        <div class="row">
          <div><strong>${s["Full Name"]}</strong><br><small>${s["LG Leader"] || "—"}</small></div>
          <div style="color:var(--red,#e53935);font-size:12px;font-weight:600">Dropped</div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function openDropStudentModal() {
  const modal = document.getElementById('modal-drop-student');
  if (!modal) return;
  // Reset to table picker step
  document.getElementById('drop-step-table').style.display = '';
  document.getElementById('drop-step-students').style.display = 'none';
  // Build table buttons
  const tableSet = [...new Set(
    APP.students
      .filter(s => (s["Status"] || "Active").toLowerCase() !== "dropped")
      .map(s => String(s["Table No"]))
  )].sort((a, b) => Number(a) - Number(b));
  const tableGrid = document.getElementById('drop-table-grid');
  if (tableGrid) {
    tableGrid.innerHTML = tableSet.map(t => `
      <button onclick="selectDropTable('${t}')" style="padding:14px;border-radius:10px;border:1.5px solid var(--border);background:#fff;font-size:15px;font-weight:700;cursor:pointer;color:var(--text1)">Table ${t}</button>
    `).join('');
  }
  modal.style.display = 'flex';
}

function selectDropTable(tableNo) {
  document.getElementById('drop-step-table').style.display = 'none';
  document.getElementById('drop-step-students').style.display = '';
  document.getElementById('drop-step-table-label').textContent = `Table ${tableNo} — Select Student`;
  const students = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const list = document.getElementById('drop-student-list');
  if (!list) return;
  if (!students.length) {
    list.innerHTML = '<p style="padding:12px;color:var(--gray);text-align:center">No active students in this table.</p>';
    return;
  }
  list.innerHTML = students.map(s => `
    <div onclick="confirmDropStudent('${s["Student ID"]}', '${s["Full Name"].replace(/'/g, "\\'")}')"
      style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer">
      <div style="font-size:14px;font-weight:600;color:var(--text1)">${s["Full Name"]}</div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red,#e53935)" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join('');
}

async function confirmDropStudent(studentId, studentName) {
  if (!confirm(`Drop ${studentName}? This will remove them from active student lists.`)) return;
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Student not found'); return; }
  try {
    await apiPost({
      action: "updateStudentStatus",
      studentId: student["Student ID"],
      studentName: student["Full Name"],
      status: "Dropped"
    });
    student["Status"] = "Dropped";
    showToast(`✅ ${student["Full Name"]} marked as Dropped`);
    closeDropStudentModal();
    renderDroppedStudents();
    updateAdminHomeStats();
  } catch (err) {
    console.error('confirmDropStudent error:', err);
    showToast('❌ Failed to update status');
  }
}

function closeDropStudentModal() {
  const modal = document.getElementById('modal-drop-student');
  if (modal) modal.style.display = 'none';
}


// ═══════════════════════════════════════════
// QR SCANNER
// ═══════════════════════════════════════════
let html5QrScanner = null;
let qrScanCooldown = false;

// ═══════════════════════════════════════════
// QR TAB SWITCHER
// ═══════════════════════════════════════════
function switchQRTab(tab) {
  const scanPanel = document.getElementById('qr-panel-scan');
  const genPanel  = document.getElementById('qr-panel-gen');
  const scanBtn   = document.getElementById('qr-tab-scan');
  const genBtn    = document.getElementById('qr-tab-gen');
  // Update the week label in the absent box
  const absentWeekLabel = document.getElementById('absent-week-label');
  if (absentWeekLabel) absentWeekLabel.textContent = APP.currentWeek;
  if (tab === 'scan') {
    scanPanel.style.display = ''; genPanel.style.display = 'none';
    scanBtn.style.background = 'var(--purple)'; scanBtn.style.color = '#fff';
    genBtn.style.background  = '#fff';           genBtn.style.color  = 'var(--purple)';
  } else {
    scanPanel.style.display = 'none'; genPanel.style.display = '';
    genBtn.style.background  = 'var(--purple)'; genBtn.style.color  = '#fff';
    scanBtn.style.background = '#fff';           scanBtn.style.color = 'var(--purple)';
    stopQRCamera();
    renderQRGenList();
  }
}

// ═══════════════════════════════════════════
// QR SCANNER — with live status indicator
// ═══════════════════════════════════════════
function setScanStatus(state, msg) {
  // state: 'idle' | 'scanning' | 'success' | 'error'
  const bar = document.getElementById('qr-status-bar');
  if (!bar) return;
  const colors = { idle:'#6b7280', scanning:'#7c3aed', success:'#2d6a4f', error:'#e53935' };
  const icons  = { idle:'📷', scanning:'🔍', success:'✅', error:'⚠️' };
  bar.style.display = msg ? '' : 'none';
  bar.style.background = colors[state] || colors.idle;
  bar.innerHTML = `<span style="font-size:15px">${icons[state]||''}</span> <span>${msg}</span>`;
}

function startQRCamera() {
  const placeholder = document.getElementById('qr-reader-placeholder');
  const startBtn    = document.getElementById('qr-start-btn');
  const stopBtn     = document.getElementById('qr-stop-btn');
  if (placeholder) placeholder.style.display = 'none';
  if (startBtn)    startBtn.style.display = 'none';
  if (stopBtn)     stopBtn.style.display  = '';
  if (html5QrScanner) { try { html5QrScanner.stop(); } catch(e){} html5QrScanner = null; }

  setScanStatus('scanning', 'Camera starting… point at a LIFECLASS QR code');

  html5QrScanner = new Html5Qrcode('qr-reader');
  html5QrScanner.start(
    { facingMode: 'environment' },
    { fps: 15, qrbox: { width: 230, height: 230 }, aspectRatio: 1.0 },
    onQRCodeScanned,
    (errorMsg) => {
      // Called every frame when no QR found — only update if not in cooldown
      if (!qrScanCooldown) setScanStatus('scanning', 'Scanning… point camera at QR code');
    }
  ).then(() => {
    setScanStatus('scanning', 'Camera ready — point at a LIFECLASS QR code');
  }).catch(err => {
    setScanStatus('error', 'Camera error: ' + err);
    showToast('Camera error: ' + err);
    if (placeholder) placeholder.style.display = '';
    if (startBtn)    startBtn.style.display = '';
    if (stopBtn)     stopBtn.style.display  = 'none';
  });
}

async function markAllAbsent() {
  const week = APP.currentWeek;

  // Find all active students who have NO attendance record for this week
  const alreadyScanned = new Set(
    APP.attendance
      .filter(a => String(a['Week No']) === String(week))
      .map(a => String(a['Student ID']))
  );
  const unscanned = APP.students.filter(s =>
    (s['Status'] || 'Active').toLowerCase() !== 'dropped' &&
    !alreadyScanned.has(String(s['Student ID']))
  );

  if (!unscanned.length) {
    showToast('✅ All students already have attendance for Week ' + week);
    return;
  }

  const confirmed = confirm(
    `Mark ${unscanned.length} unscanned student(s) as ABSENT for Week ${week}?\n\n` +
    unscanned.map(s => '• ' + s['Full Name']).join('\n')
  );
  if (!confirmed) return;

  const resultEl = document.getElementById('qr-result');
  if (resultEl) resultEl.innerHTML = `<div style="padding:12px;color:#666;font-size:13px">Marking ${unscanned.length} student(s) absent…</div>`;

  let done = 0;
  for (const s of unscanned) {
    try {
      await apiPost({
        action: 'addAttendance',
        studentId: s['Student ID'],
        studentName: s['Full Name'],
        age: s['Age'] || '',
        gender: s['Gender'] || '',
        lgLeader: s['LG Leader'] || '',
        networkLeader: s['Network Leader'] || '',
        tableNo: s['Table No'],
        weekNo: week,
        status: 'Absent',
        remarks: 'Auto-marked absent — did not scan'
      });
      done++;
    } catch (e) {
      console.error('Failed to mark absent:', s['Full Name'], e);
    }
  }

  await loadAllData();
  showToast(`❌ ${done} student(s) marked Absent for Week ${week}`);
  if (resultEl) resultEl.innerHTML = `
    <div style="background:#fdecea;padding:14px 16px;border-radius:12px;border-left:4px solid #e53935;margin-top:8px">
      <div style="font-weight:700;font-size:14px;color:#7a0000">❌ ${done} Student(s) Marked Absent — Week ${week}</div>
      <div style="margin-top:8px;font-size:12px;color:#b71c1c">${unscanned.map(s => s['Full Name']).join(', ')}</div>
    </div>`;
}

function stopQRCamera() {
  if (html5QrScanner) { html5QrScanner.stop().catch(()=>{}); html5QrScanner = null; }
  const placeholder = document.getElementById('qr-reader-placeholder');
  const startBtn    = document.getElementById('qr-start-btn');
  const stopBtn     = document.getElementById('qr-stop-btn');
  const reader      = document.getElementById('qr-reader');
  if (placeholder) placeholder.style.display = '';
  if (startBtn)    startBtn.style.display = '';
  if (stopBtn)     stopBtn.style.display  = 'none';
  if (reader)      reader.innerHTML = '';
  setScanStatus('idle', '');
}

async function onQRCodeScanned(decodedText) {
  if (qrScanCooldown) return;
  qrScanCooldown = true;

  // Flash green on the scanner box
  const scanBox = document.querySelector('.qr-scan-box');
  if (scanBox) {
    scanBox.style.outline = '4px solid #4ade80';
    setTimeout(() => { scanBox.style.outline = ''; }, 600);
  }

  if (!decodedText.startsWith(QR_PREFIX)) {
    setScanStatus('error', 'Invalid QR — only LIFECLASS QR codes accepted');
    const resultEl = document.getElementById('qr-result');
    if (resultEl) resultEl.innerHTML = `
      <div style="background:#fff3cd;padding:14px 16px;border-radius:12px;border-left:4px solid #e8a020;margin-top:8px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:20px">⚠️</span>
        <div><strong>Invalid QR Code</strong><br><span style="font-size:12px;color:#666">Only LIFECLASS QR codes are accepted. Try the QR Generator tab to create one.</span></div>
      </div>`;
    showToast('⚠️ Not a LIFECLASS QR code');
    setTimeout(() => {
      qrScanCooldown = false;
      setScanStatus('scanning', 'Scanning… point camera at QR code');
    }, 3000);
    return;
  }

  const personId = decodedText.slice(QR_PREFIX.length);
  const student  = APP.students.find(s => String(s['Student ID']) === String(personId));
  if (student) { await scanQR(student['Student ID']); setTimeout(() => { qrScanCooldown = false; setScanStatus('scanning','Ready — scan next'); }, 3000); return; }
  const faculty  = APP.faculty.find(f => String(f['Faculty ID']) === String(personId));
  if (faculty)  { await scanFacultyQR(faculty['Faculty ID']); setTimeout(() => { qrScanCooldown = false; setScanStatus('scanning','Ready — scan next'); }, 3000); return; }

  setScanStatus('error', 'QR not recognised — ID: ' + personId);
  showToast('QR not recognised: ' + personId);
  setTimeout(() => { qrScanCooldown = false; setScanStatus('scanning','Scanning…'); }, 3000);
}

// ── Attendance time rules ──────────────────────────────────────
// Present : 1:00 PM – 1:44 PM  (13:00–13:44)
// Late    : 1:45 PM – 2:29 PM  (13:45–14:29)
// Absent  : 2:30 PM onwards    (14:30+)
// 3 Lates accumulated → 3rd Late becomes Absent automatically
// ──────────────────────────────────────────────────────────────
function getScanAttendanceStatus() {
  const now  = new Date();
  const h    = now.getHours();
  const m    = now.getMinutes();
  const mins = h * 60 + m;            // minutes since midnight
  const presentStart = 13 * 60;       // 1:00 PM
  const presentEnd   = 13 * 60 + 44;  // 1:44 PM
  const lateEnd      = 14 * 60 + 29;  // 2:29 PM
  if (mins >= presentStart && mins <= presentEnd) return 'Present';
  if (mins > presentEnd   && mins <= lateEnd)     return 'Late';
  return 'Absent'; // 2:30 PM and beyond
}

function countStudentLates(studentId) {
  return APP.attendance.filter(a =>
    String(a['Student ID']) === String(studentId) &&
    (a['Attendance Status'] || a['Status'] || '').toLowerCase() === 'late'
  ).length;
}

// Count UNEXCUSED absences (absences with no approved makeup)
function countUnexcusedAbsences(studentId) {
  const absences = APP.attendance.filter(a =>
    String(a['Student ID']) === String(studentId) &&
    (a['Attendance Status'] || a['Status'] || '').toLowerCase() === 'absent'
  );
  // An absence is excused if there's an approved makeup for same student+week
  const approvedMakeupWeeks = new Set(
    (APP.makeups || [])
      .filter(m => String(m['Student ID']) === String(studentId) && (m['Status'] || '').toLowerCase() === 'approved')
      .map(m => String(m['Week No']))
  );
  return absences.filter(a => !approvedMakeupWeeks.has(String(a['Week No']))).length;
}

// Check if student should be auto-dropped (3 unexcused absences)
async function checkAndAutoDropStudent(student) {
  const unexcused = countUnexcusedAbsences(student['Student ID']);
  if (unexcused >= 3 && (student['Status'] || 'Active').toLowerCase() !== 'dropped') {
    // Auto-drop
    try {
      await apiPost({ action: 'updateStudentStatus', studentId: student['Student ID'], studentName: student['Full Name'], status: 'Dropped' });
      student['Status'] = 'Dropped';
    } catch(e) { console.error('Auto-drop failed:', e); }
    return true;
  }
  return false;
}

async function scanQR(id) {
  const student = APP.students.find(s => String(s['Student ID']) === String(id));
  if (!student) return;
  setScanStatus('scanning', 'Saving attendance for ' + student['Full Name'] + '…');

  const now        = new Date();
  const scanTime   = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true });
  let   status     = getScanAttendanceStatus();
  let   remarks    = '';
  let   alertType  = null; // 'warning-2nd' | 'alert-3rd'

  // 3-lates-to-absent rule: count existing lates BEFORE this scan
  if (status === 'Late') {
    const prevLates = countStudentLates(student['Student ID']);
    if (prevLates >= 2) {
      // This is the 3rd late → convert to Absent
      status    = 'Absent';
      remarks   = '3 lates converted to Absent';
      alertType = 'alert-3rd';
    } else if (prevLates === 1) {
      // This is the 2nd late → warn the team
      alertType = 'warning-2nd';
    }
  }

  await apiPost({
    action:'addQRScan', qrCode:String(student['Student ID']),
    personType:'student', personId:student['Student ID'],
    name:student['Full Name'], weekNo:APP.currentWeek, scanType:'attendance'
  });
  await apiPost({
    action:'addAttendance', studentId:student['Student ID'],
    studentName:student['Full Name'], age:student['Age']||'',
    gender:student['Gender']||'', lgLeader:student['LG Leader']||'',
    networkLeader:student['Network Leader']||'', tableNo:student['Table No'],
    weekNo:APP.currentWeek, status, remarks
  });

  // Reload data so late/absent count is fresh
  await loadAllData();

  // Check 3-absences → auto-drop rule
  let autoDropped = false;
  if (status === 'Absent') {
    autoDropped = await checkAndAutoDropStudent(student);
  }

  // Build result card
  const isPresent = status === 'Present';
  const isLate    = status === 'Late';
  const isAbsent  = status === 'Absent';

  const cardBg     = isPresent ? '#e8f5ee' : isLate ? '#fff5e0' : '#fdecea';
  const cardBorder = isPresent ? '#2d6a4f' : isLate ? '#c9960c' : '#e53935';
  const cardText   = isPresent ? '#1a3a2a' : isLate ? '#7a5a00' : '#7a0000';
  const icon       = isPresent ? '✅' : isLate ? '🕐' : '❌';
  const label      = isPresent ? 'PRESENT' : isLate ? 'LATE' : 'ABSENT';

  setScanStatus('success', `${student['Full Name']} marked ${label} ✓`);
  const resultEl = document.getElementById('qr-result');

  // 2nd Late — warning card below the result
  const warningHtml = alertType === 'warning-2nd' ? `
    <div style="background:#fff3cd;border:2px solid #f0a500;border-radius:12px;padding:14px 16px;margin-top:10px;display:flex;gap:10px;align-items:flex-start">
      <span style="font-size:26px;flex-shrink:0">⚠️</span>
      <div>
        <div style="font-weight:800;font-size:14px;color:#7a4f00">LATE WARNING — 2nd Late</div>
        <div style="font-size:12px;color:#7a4f00;margin-top:4px"><strong>${student['Full Name']}</strong> now has <strong>2 lates</strong>.<br>One more late will be converted to <strong>ABSENT</strong>.</div>
      </div>
    </div>` : '';

  if (resultEl) resultEl.innerHTML = `
    <div style="background:${cardBg};padding:14px 16px;border-radius:12px;border-left:4px solid ${cardBorder};margin-top:8px;display:flex;gap:10px;align-items:center">
      <span style="font-size:28px">${icon}</span>
      <div>
        <div style="font-weight:700;font-size:15px;color:${cardText}">${student['Full Name']}</div>
        <div style="font-size:12px;color:${cardBorder}">Marked <strong>${label}</strong> — Week ${APP.currentWeek} · Table ${student['Table No']}</div>
        <div style="font-size:11px;color:#666;margin-top:2px">Scanned at ${scanTime}${remarks ? ' · ' + remarks : ''}</div>
      </div>
    </div>${warningHtml}`;

  // 3rd Late → Absent: show full-screen flashing alert modal
  if (alertType === 'alert-3rd') {
    showLateAbsentAlert(student['Full Name'], student['Table No'], scanTime);
  } else if (autoDropped) {
    showAutoDropAlert(student['Full Name'], student['Table No'], scanTime);
  }

  showToast(`${icon} ${student['Full Name']} — ${label}`);
}

function showLateAbsentAlert(name, tableNo, scanTime) {
  // Remove existing alert if any
  const existing = document.getElementById('late-absent-alert-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'late-absent-alert-overlay';
  overlay.style.cssText = `
    position:fixed;top:0;left:0;width:100%;height:100%;
    background:rgba(180,0,0,0.92);z-index:99999;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    animation:latePulse 0.6s ease-in-out infinite alternate;
    padding:24px;box-sizing:border-box;text-align:center;
  `;

  overlay.innerHTML = `
    <style>
      @keyframes latePulse {
        from { background: rgba(180,0,0,0.92); }
        to   { background: rgba(220,0,0,0.98); }
      }
      @keyframes bounceIn {
        0%   { transform: scale(0.5); opacity:0; }
        70%  { transform: scale(1.1); }
        100% { transform: scale(1);   opacity:1; }
      }
    </style>
    <div style="animation:bounceIn 0.4s ease-out forwards">
      <div style="font-size:72px;margin-bottom:8px">🚨</div>
      <div style="font-size:13px;font-weight:800;color:rgba(255,255,255,0.7);letter-spacing:3px;margin-bottom:8px">ATTENDANCE ALERT</div>
      <div style="font-size:28px;font-weight:900;color:#fff;line-height:1.2;margin-bottom:6px">${name}</div>
      <div style="font-size:14px;color:rgba(255,255,255,0.85);margin-bottom:20px">Table ${tableNo} · Scanned at ${scanTime}</div>
      <div style="background:rgba(0,0,0,0.35);border-radius:14px;padding:16px 24px;margin-bottom:24px;max-width:320px">
        <div style="font-size:15px;font-weight:800;color:#ffd700;margin-bottom:6px">3 LATES = 1 ABSENT</div>
        <div style="font-size:13px;color:#fff;line-height:1.5">This student has accumulated <strong>3 lates</strong>.<br>This scan has been automatically recorded as <strong style="color:#ffd700">ABSENT</strong>.</div>
      </div>
      <div style="font-size:11px;color:rgba(255,255,255,0.6);margin-bottom:20px">Please inform the student and their table guide.</div>
      <button onclick="document.getElementById('late-absent-alert-overlay').remove()"
        style="background:#fff;color:#c00;font-weight:800;font-size:15px;border:none;border-radius:12px;padding:14px 40px;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,0.3)">
        ✓ ACKNOWLEDGED
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  // Auto-dismiss after 15 seconds if not acknowledged
  setTimeout(() => {
    const el = document.getElementById('late-absent-alert-overlay');
    if (el) el.remove();
  }, 15000);
}

  setScanStatus('success', `${student['Full Name']} marked ${label} ✓`);
  const resultEl = document.getElementById('qr-result');
  if (resultEl) resultEl.innerHTML = `
    <div style="background:${cardBg};padding:14px 16px;border-radius:12px;border-left:4px solid ${cardBorder};margin-top:8px;display:flex;gap:10px;align-items:center">
      <span style="font-size:28px">${icon}</span>
      <div>
        <div style="font-weight:700;font-size:15px;color:${cardText}">${student['Full Name']}</div>
        <div style="font-size:12px;color:${cardBorder}">Marked <strong>${label}</strong> — Week ${APP.currentWeek} · Table ${student['Table No']}</div>
        <div style="font-size:11px;color:#666;margin-top:2px">Scanned at ${scanTime}${remarks ? ' · ' + remarks : ''}</div>
      </div>
    </div>`;
  showToast(`${icon} ${student['Full Name']} — ${label}`);


function showAutoDropAlert(name, tableNo, scanTime) {
  const existing = document.getElementById('late-absent-alert-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'late-absent-alert-overlay';
  overlay.style.cssText = `
    position:fixed;top:0;left:0;width:100%;height:100%;
    background:rgba(80,0,0,0.95);z-index:99999;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    animation:latePulse 0.6s ease-in-out infinite alternate;
    padding:24px;box-sizing:border-box;text-align:center;
  `;
  overlay.innerHTML = `
    <div style="animation:bounceIn 0.4s ease-out forwards">
      <div style="font-size:72px;margin-bottom:8px">🚫</div>
      <div style="font-size:13px;font-weight:800;color:rgba(255,255,255,0.7);letter-spacing:3px;margin-bottom:8px">STUDENT DROPPED</div>
      <div style="font-size:28px;font-weight:900;color:#fff;line-height:1.2;margin-bottom:6px">${name}</div>
      <div style="font-size:14px;color:rgba(255,255,255,0.85);margin-bottom:20px">Table ${tableNo} · Scanned at ${scanTime}</div>
      <div style="background:rgba(0,0,0,0.4);border-radius:14px;padding:16px 24px;margin-bottom:24px;max-width:340px">
        <div style="font-size:15px;font-weight:800;color:#ffd700;margin-bottom:8px">3 UNEXCUSED ABSENCES</div>
        <div style="font-size:13px;color:#fff;line-height:1.6">This student has reached <strong>3 unexcused absences</strong> and has been automatically <strong style="color:#ffd700">DROPPED</strong> from the class.<br><br>Please coordinate with the Lifeclass Team.</div>
      </div>
      <button onclick="document.getElementById('late-absent-alert-overlay').remove()"
        style="background:#fff;color:#7a0000;font-weight:800;font-size:15px;border:none;border-radius:12px;padding:14px 40px;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,0.3)">
        ✓ ACKNOWLEDGED
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => { const el = document.getElementById('late-absent-alert-overlay'); if (el) el.remove(); }, 15000);
}

async function scanFacultyQR(id) {
  const faculty = APP.faculty.find(f => String(f['Faculty ID']) === String(id));
  if (!faculty) return;
  setScanStatus('scanning', 'Saving attendance for ' + faculty['Full Name'] + '…');

  await apiPost({
    action:'addQRScan', qrCode:String(faculty['Faculty ID']),
    personType:'faculty', personId:faculty['Faculty ID'],
    name:faculty['Full Name'], weekNo:APP.currentWeek, scanType:'attendance'
  });
  await apiPost({
    action:'addFacultyAttendance', facultyId:faculty['Faculty ID'],
    facultyName:faculty['Full Name'], role:faculty['Role']||'',
    weekNo:APP.currentWeek, status:'Present'
  });

  setScanStatus('success', faculty['Full Name'] + ' (' + (faculty['Role']||'') + ') marked PRESENT ✓');
  const resultEl = document.getElementById('qr-result');
  if (resultEl) resultEl.innerHTML = `
    <div style="background:#e8f5ee;padding:14px 16px;border-radius:12px;border-left:4px solid #2d6a4f;margin-top:8px;display:flex;gap:10px;align-items:center">
      <span style="font-size:28px">✅</span>
      <div>
        <div style="font-weight:700;font-size:15px;color:#1a3a2a">${faculty['Full Name']}</div>
        <div style="font-size:12px;color:#2d6a4f"><strong>${faculty['Role']||'Faculty'}</strong> marked PRESENT — Week ${APP.currentWeek}</div>
        <div style="font-size:11px;color:#666;margin-top:2px">${new Date().toLocaleTimeString()}</div>
      </div>
    </div>`;
  showToast('✅ ' + faculty['Full Name'] + ' — Present');
}

// ═══════════════════════════════════════════
// QR GENERATOR — uses qrcode.js reliably via img tag
// ═══════════════════════════════════════════
let qrGenCurrentId   = null;
let qrGenCurrentName = null;

function renderQRGenList() {
  const type   = document.getElementById('qrgen-type')?.value || 'student';
  const search = (document.getElementById('qrgen-search')?.value || '').toLowerCase();
  const list   = document.getElementById('qrgen-list');
  if (!list) return;

  const items = type === 'student'
    ? APP.students.filter(s => (s['Status']||'').toLowerCase() !== 'dropped' && (!search || s['Full Name'].toLowerCase().includes(search) || String(s['Student ID']).includes(search)))
    : APP.faculty.filter(f  => !search || f['Full Name'].toLowerCase().includes(search) || String(f['Faculty ID']).includes(search));

  if (!items.length) {
    list.innerHTML = '<p style="color:var(--text3);font-size:13px;text-align:center;padding:20px">No results found.</p>';
    return;
  }

  list.innerHTML = items.map(item => {
    const id   = type === 'student' ? item['Student ID'] : item['Faculty ID'];
    const name = item['Full Name'];
    const sub  = type === 'student' ? `ID: ${id} · Table ${item['Table No']}` : `ID: ${id} · ${item['Role']}`;
    const initials = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    return `<div onclick="openQRModal('${String(id).replace(/'/g,"\'")}','${name.replace(/'/g,"\'")}','${sub.replace(/'/g,"\'")}',this)"
      style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:#f8f8f8;border-radius:10px;cursor:pointer;border:1.5px solid transparent;transition:border-color 0.15s"
      onmouseover="this.style.borderColor='var(--purple)'" onmouseout="this.style.borderColor='transparent'">
      <div style="width:38px;height:38px;background:var(--purple);border-radius:9px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;flex-shrink:0">${initials}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text1)">${name}</div>
        <div style="font-size:11px;color:var(--text3)">${sub}</div>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--purple)" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
    </div>`;
  }).join('');
}

function openQRModal(id, name, sub) {
  qrGenCurrentId   = id;
  qrGenCurrentName = name;
  const modal = document.getElementById('qrgen-modal');
  modal.style.display = 'flex';
  document.getElementById('qrgen-modal-name').textContent = name;
  document.getElementById('qrgen-modal-id').textContent   = sub;

  // Show loading state
  const canvas = document.getElementById('qrgen-canvas');
  const qrWrap = document.getElementById('qrgen-img-wrap');

  // Use qrcode library — render into a fresh temp div then grab the img/canvas
  const tempDiv = document.createElement('div');
  tempDiv.style.position = 'absolute';
  tempDiv.style.visibility = 'hidden';
  document.body.appendChild(tempDiv);

  const qrPayload = QR_PREFIX + String(id);

  // Clear previous
  if (qrWrap) qrWrap.innerHTML = '<div style="color:#999;font-size:13px;padding:20px">Generating…</div>';

  new QRCode(tempDiv, {
    text: qrPayload,
    width: 240, height: 240,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  setTimeout(() => {
    // QRCode lib renders either canvas or img depending on browser
    const generatedCanvas = tempDiv.querySelector('canvas');
    const generatedImg    = tempDiv.querySelector('img');

    if (qrWrap) {
      if (generatedCanvas) {
        // Copy to our display canvas
        canvas.width  = generatedCanvas.width;
        canvas.height = generatedCanvas.height;
        canvas.getContext('2d').drawImage(generatedCanvas, 0, 0);
        canvas.style.display = '';
        qrWrap.innerHTML = '';
        qrWrap.appendChild(canvas);
      } else if (generatedImg) {
        // Some browsers generate an img — use it directly
        const img = document.createElement('img');
        img.src = generatedImg.src;
        img.style.cssText = 'width:240px;height:240px;border-radius:8px;display:block';
        img.onload = () => {
          // Also copy to canvas for download
          canvas.width = 240; canvas.height = 240;
          canvas.getContext('2d').drawImage(img, 0, 0, 240, 240);
        };
        qrWrap.innerHTML = '';
        qrWrap.appendChild(img);
      } else {
        qrWrap.innerHTML = '<div style="color:#e53935;font-size:13px;padding:20px">Failed to generate QR. Refresh and try again.</div>';
      }
    }

    document.body.removeChild(tempDiv);

    // Show payload for debugging
    const payloadEl = document.getElementById('qrgen-payload');
    if (payloadEl) payloadEl.textContent = 'Payload: ' + qrPayload;
  }, 200);
}

function closeQRModal() {
  document.getElementById('qrgen-modal').style.display = 'none';
}

function downloadQRCode() {
  const canvas = document.getElementById('qrgen-canvas');
  const link   = document.createElement('a');
  link.download = `LIFECLASS_QR_${qrGenCurrentId}_${(qrGenCurrentName||'').replace(/\s+/g,'_')}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// Stop camera when navigating away
(function() {
  const _origGo = go;
  go = function(id) {
    if (id !== 's-r-qr' && html5QrScanner) stopQRCamera();
    _origGo(id);
  };
})();

// ═══════════════════════════════════════════
// ADMIN — TABLE ADD CREDIT MODAL
// ═══════════════════════════════════════════
function openTableAddCredit() {
  const modal = document.getElementById('modal-table-credit');
  if (!modal) return;
  const tableNo    = document.getElementById('a-td-title')?.textContent?.replace('Table ','').trim();
  const modalTitle = document.getElementById('modal-table-credit-title');
  if (modalTitle) modalTitle.textContent = `Add LC Credits — Table ${tableNo}`;
  modal.style.display = 'flex';
  document.querySelectorAll('#modal-table-credit .reason-btn').forEach((b, i) => {
    b.classList.toggle('selected', i === 0);
  });
  APP.selectedReason = 'Attendance';
  const otherWrap = document.getElementById('modal-other-wrap');
  if (otherWrap) otherWrap.style.display = 'none';
  const otherText = document.getElementById('modal-other-text');
  if (otherText) otherText.value = '';
  const amountEl = document.getElementById('modal-credit-amount');
  if (amountEl) amountEl.value = 5;
}

function closeTableCreditModal() {
  const modal = document.getElementById('modal-table-credit');
  if (modal) modal.style.display = 'none';
}

async function doTableAddCredit() {
  const tableNo = document.getElementById('a-td-title')?.textContent?.replace('Table ','').trim();
  const amount  = Number(document.getElementById('modal-credit-amount')?.value || 5);
  const rawReason = APP.selectedReason || 'Attendance';
  const reason  = rawReason === '__other__'
    ? (document.getElementById('modal-other-text')?.value?.trim() || 'Other')
    : rawReason;

  if (!tableNo) { showToast('⚠️ Table not found'); return; }
  if (!amount || amount < 1) { showToast('⚠️ Enter a valid credit amount'); return; }

  try {
    const btn = document.getElementById('modal-add-credit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    await apiPost({
      action:      'addCredit',
      studentId:   '',
      studentName: `Table ${tableNo} (Group)`,
      tableNo:     tableNo,
      weekNo:      APP.currentWeek,
      reason,
      creditsAdded: amount,
      addedBy:     APP.currentFaculty?.["Full Name"] || 'Admin'
    });

    closeTableCreditModal();
    await loadAllData();
    showToast(`✅ ${amount} LC added to Table ${tableNo}`);
    showTableDetail(tableNo);
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to save'));
    console.error('doTableAddCredit error:', err);
  } finally {
    const btn = document.getElementById('modal-add-credit-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Add Credits to Table'; }
  }
}

// ═══════════════════════════════════════════
// RECORD — ATTENDANCE TAB SWITCH
// ═══════════════════════════════════════════
function switchAttTab(tab) {
  const sPanel = document.getElementById('att-panel-students');
  const fPanel = document.getElementById('att-panel-faculty');
  const sBtn   = document.getElementById('att-tab-students');
  const fBtn   = document.getElementById('att-tab-faculty');
  if (tab === 'students') {
    sPanel.style.display = ''; fPanel.style.display = 'none';
    sBtn.style.background = 'var(--purple)'; sBtn.style.color = '#fff';
    fBtn.style.background = '#fff';          fBtn.style.color = 'var(--purple)';
    renderRAttendance();
  } else {
    sPanel.style.display = 'none'; fPanel.style.display = '';
    fBtn.style.background = 'var(--purple)'; fBtn.style.color = '#fff';
    sBtn.style.background = '#fff';          sBtn.style.color = 'var(--purple)';
    renderRFacultyAtt();
  }
}

function renderRFacultyAtt() {
  const el   = document.getElementById('r-fac-att-list');
  const week = document.getElementById('r-fac-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.facultyAttendance.filter(a => String(a["Week No"]) === String(week));
  if (!weekAtt.length) {
    el.innerHTML = `<p style="padding:16px;color:var(--gray)">No faculty attendance for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = weekAtt.map(a => {
    const name     = a["Faculty Name"] || a["FacultyName"] || "—";
    const initials = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const role     = a["Role"]   || "—";
    const status   = a["Status"] || "Present";
    const time     = formatDate(a["Scan Time"] || a["ScanTime"]);
    const badgeCls = status.toLowerCase() === 'late' ? 'ba' : 'bg';
    return `
      <div class="att-row">
        <div class="av">${initials}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">${name}</div>
          <div style="font-size:11px;color:var(--text3)">${role}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">Scanned ${time}</div>
        </div>
        <span class="badge ${badgeCls}">${status}</span>
      </div>
    `;
  }).join('');
}

function renderRAttendance() {
  const el   = document.getElementById('r-att-list');
  const week = document.getElementById('r-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.attendance.filter(a => String(a["Week No"]) === String(week));
  if (!weekAtt.length) {
    el.innerHTML = `<p style="padding:16px;color:var(--gray)">No attendance for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = weekAtt.map(a => `
    <div class="row">
      <div>
        <strong>${a["Student Name"] || a["StudentName"] || "—"}</strong><br>
        <small>${formatDate(a["Scan Time"] || a["ScanTime"])}</small>
      </div>
      <div>${a["Attendance Status"] || a["Status"] || "Present"}</div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════
// BALANCES
// ═══════════════════════════════════════════
function renderBalances() {
  const el = document.getElementById('r-bal-list');
  if (!el) return;
  if (!APP.students.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No student records.</p>';
    return;
  }
  const sorted = [...APP.students].sort((a, b) => {
    const pa = getStudentPayment(a["Student ID"]);
    const pb = getStudentPayment(b["Student ID"]);
    return pb.balance - pa.balance;
  });
  el.innerHTML = sorted.map(s => {
    const pay = getStudentPayment(s["Student ID"]);
    return `
      <div class="row">
        <div>
          <strong>${s["Full Name"]}</strong><br>
          <small>Table ${s["Table No"]} · ₱${pay.paid.toLocaleString()} paid</small>
        </div>
        <div style="color:${pay.balance > 0 ? 'var(--red,#e53935)' : 'var(--green)'}">
          ₱${pay.balance.toLocaleString()}
        </div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// PRINT
// ═══════════════════════════════════════════
function printAttendance() {
  const data = APP.attendance.map(a => `
    <tr>
      <td>${formatDate(a["Scan Time"] || a["ScanTime"])}</td>
      <td>${a["Student Name"] || a["StudentName"] || ""}</td>
      <td>${a["Age"]            || ""}</td>
      <td>${a["Gender"]         || ""}</td>
      <td>${a["LG Leader"]      || ""}</td>
      <td>${a["Network Leader"] || ""}</td>
    </tr>
  `).join("");
  const win = window.open("", "", "width=900,height=700");
  win.document.write(`
    <html><head><title>Student Attendance Print</title>
    <style>
      @page { size: A4 portrait; margin: 20mm; }
      body { font-family: Arial, sans-serif; }
      h2 { text-align: center; margin-bottom: 20px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #000; padding: 6px; text-align: left; }
      th { background: #f2f2f2; }
    </style></head>
    <body>
      <h2>STUDENT ATTENDANCE REPORT — ${APP.settings["Batch Name"] || "LIFECLASS"}</h2>
      <table>
        <thead><tr><th>Scan Time</th><th>Name</th><th>Age</th><th>Gender</th><th>LG Leader</th><th>Network Leader</th></tr></thead>
        <tbody>${data}</tbody>
      </table>
      <script>window.print();<\/script>
    </body></html>
  `);
  win.document.close();
}

// ═══════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════
function formatDate(val) {
  if (!val) return "—";
  try { return new Date(val).toLocaleString(); } catch { return String(val); }
}

function initClock() {
  setInterval(() => {
    const el = document.getElementById('qr-live-clock');
    if (el) el.textContent = new Date().toLocaleTimeString();
  }, 1000);
}

function updateSyncStatus(ok, msg) {
  const el  = document.getElementById('sync-label-portal');
  const dot = document.getElementById('sync-dot-portal');
  if (!el) return;
  if (ok) {
    el.textContent = 'Online · Synced';
    if (dot) { dot.style.background = '#27ae60'; dot.style.boxShadow = '0 0 0 3px rgba(39,174,96,0.25)'; }
  } else if (msg) {
    el.textContent = '⚠️ ' + msg;
    if (dot) { dot.style.background = '#e67e22'; dot.style.boxShadow = '0 0 0 3px rgba(230,126,34,0.25)'; }
  } else {
    el.textContent = 'Syncing…';
    if (dot) { dot.style.background = ''; dot.style.boxShadow = ''; }
  }
}

// ═══════════════════════════════════════════
// WEEK DROPDOWNS
// ═══════════════════════════════════════════
function populateWeekDropdowns() {
  const weekOptions = APP.lessons.map(l =>
    `<option value="${l["Week No"]}"${Number(l["Week No"]) === APP.currentWeek ? ' selected' : ''}>Lesson ${l["Week No"]}${l["Lesson Title"] ? ' – ' + l["Lesson Title"] : ''}</option>`
  ).join('');

  const fWeek = document.getElementById('f-week-filter');
  if (fWeek && weekOptions) fWeek.innerHTML = weekOptions;

  ['a-att-week', 'a-table-week', 'a-fac-att-week'].forEach(id => {
    const el = document.getElementById(id);
    if (el && weekOptions) el.innerHTML = weekOptions;
  });

  const rAtt    = document.getElementById('r-att-week');
  if (rAtt    && weekOptions) rAtt.innerHTML    = weekOptions;
  const rFacAtt = document.getElementById('r-fac-att-week');
  if (rFacAtt && weekOptions) rFacAtt.innerHTML = weekOptions;

  const mkp = document.getElementById('makeup-week');
  if (mkp && APP.lessons.length) {
    mkp.innerHTML = `<option value="0">All Weeks</option>` +
      APP.lessons.map(l => `<option value="${l["Week No"]}">Week ${l["Week No"]} absences</option>`).join('');
  }
}

// ═══════════════════════════════════════════
// ADMIN HOME STATS
// ═══════════════════════════════════════════
function updateAdminHomeStats() {
  const totalStudentsEl = document.getElementById('a-total-students');
  const totalFacultyEl  = document.getElementById('a-total-faculty');
  const totalPaidEl     = document.getElementById('a-total-paid');
  const totalDroppedEl  = document.getElementById('a-total-dropped');

  const activeStudents = APP.students.filter(s =>
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const droppedStudents = APP.students.filter(s =>
    (s["Status"] || "Active").toLowerCase() === "dropped"
  );

  if (totalStudentsEl) totalStudentsEl.textContent = activeStudents.length;
  if (totalFacultyEl)  totalFacultyEl.textContent  = APP.faculty.length;
  if (totalDroppedEl)  totalDroppedEl.textContent  = droppedStudents.length;
  if (totalPaidEl) {
    const total = APP.payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
    totalPaidEl.textContent = `₱${total.toLocaleString()}`;
  }

  const absentStudentIds = new Set(
    APP.attendance
      .filter(a => (a["Attendance Status"] || a["Status"] || "").toLowerCase() === "absent")
      .map(a => String(a["Student ID"]))
  );
  const badge = document.getElementById('a-makeup-badge');
  if (badge) {
    if (absentStudentIds.size > 0) { badge.textContent = `${absentStudentIds.size} pending`; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  }

  // Dropped students badge
  const droppedCount = APP.students.filter(s =>
    (s["Status"] || "").toLowerCase() === "dropped"
  ).length;
  const droppedBadge = document.getElementById('a-dropped-badge');
  if (droppedBadge) {
    if (droppedCount > 0) { droppedBadge.textContent = `${droppedCount}`; droppedBadge.style.display = ''; }
    else { droppedBadge.style.display = 'none'; }
  }
}

// ═══════════════════════════════════════════
// FACULTY HOME
// ═══════════════════════════════════════════
function updateFacultyHome() {
  const nameEl = document.getElementById('f-home-name');
  const roleEl = document.getElementById('f-home-role');
  const f = APP.currentFaculty || APP.faculty[0];
  if (!f) return;
  if (nameEl) nameEl.textContent = f["Full Name"] || "—";
  if (roleEl) roleEl.textContent = `${f["Role"] || ""}${f["Table Assigned"] ? ' · Table ' + f["Table Assigned"] : ''}`;

  const tableNo = f["Table Assigned"] || "";
  ['f-students-topbar','f-payment-topbar','f-credits-topbar'].forEach(id => {
    const el = document.getElementById(id);
    if (el && tableNo) {
      const labels = { 'f-students-topbar': 'Students', 'f-payment-topbar': 'Payment', 'f-credits-topbar': 'LC Credits' };
      el.textContent = `Table ${tableNo} — ${labels[id]}`;
    }
  });
}

// ═══════════════════════════════════════════
// ADMIN — FACULTY ATTENDANCE
// ═══════════════════════════════════════════
function renderAFacultyAtt() {
  const el   = document.getElementById('a-fac-att-list');
  const week = document.getElementById('a-fac-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.facultyAttendance.filter(a => String(a["Week No"]) === String(week));
  if (!weekAtt.length) {
    el.innerHTML = `<p style="padding:16px;color:var(--gray)">No faculty attendance for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = weekAtt.map(a => {
    const name     = a["Faculty Name"] || a["FacultyName"] || "—";
    const initials = name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const role     = a["Role"]   || "—";
    const status   = a["Status"] || "Present";
    const time     = formatDate(a["Scan Time"] || a["ScanTime"]);
    const badgeCls = status.toLowerCase() === 'late' ? 'ba' : 'bg';
    return `
      <div class="att-row">
        <div class="av">${initials}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">${name}</div>
          <div style="font-size:11px;color:var(--text3)">${role}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">Scanned ${time}</div>
        </div>
        <span class="badge ${badgeCls}">${status}</span>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// ADMIN — MAKEUP LESSONS
// ═══════════════════════════════════════════
function renderMakeup() {
  const el   = document.getElementById('makeup-list');
  const week = document.getElementById('makeup-week')?.value || '0';
  if (!el) return;

  let absences = APP.attendance.filter(a =>
    (a['Attendance Status'] || a['Status'] || '').toLowerCase() === 'absent'
  );
  if (week !== '0') absences = absences.filter(a => String(a['Week No']) === String(week));

  if (!absences.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No absences found.</p>';
    return;
  }

  const today = new Date();

  el.innerHTML = absences.map(a => {
    const studentId = String(a['Student ID'] || '');
    const weekNo    = String(a['Week No'] || '');
    const name      = a['Student Name'] || a['StudentName'] || '—';
    const tableNo   = a['Table No'] || '—';

    const makeup = (APP.makeups || []).find(m =>
      String(m['Student ID']) === studentId && String(m['Week No']) === weekNo
    );

    const absenceDate = a['Timestamp'] ? new Date(a['Timestamp']) : null;
    let deadlineHtml = '', daysLeft = null;
    if (absenceDate && !isNaN(absenceDate)) {
      const deadline = new Date(absenceDate);
      deadline.setDate(deadline.getDate() + 7);
      daysLeft = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
      const deadlineStr  = deadline.toLocaleDateString('en-PH', { month:'short', day:'numeric', year:'numeric' });
      const deadlineColor = daysLeft < 0 ? '#e53935' : daysLeft <= 2 ? '#c9960c' : '#2d6a4f';
      deadlineHtml = `<div style="font-size:10px;color:${deadlineColor};font-weight:600;margin-top:3px">
        ${daysLeft < 0 ? '⛔ Make-up deadline passed' : `⏰ ${daysLeft} day(s) left — due ${deadlineStr}`}
      </div>`;
    }

    let statusBadge, actionBtns;
    if (!makeup) {
      statusBadge = `<span style="background:#fdecea;color:#e53935;font-size:10px;font-weight:700;padding:3px 8px;border-radius:12px">Unexcused</span>`;
      actionBtns  = (daysLeft === null || daysLeft >= 0)
        ? `<button onclick="openMakeupRequest('${studentId}','${weekNo}','${name.replace(/'/g,"\\'")}','${tableNo}')"
            style="margin-top:8px;width:100%;background:#e8f5ee;color:#2d6a4f;border:1.5px solid #2d6a4f;border-radius:8px;padding:7px;font-size:11px;font-weight:700;cursor:pointer">
            📋 File Make-up Request
          </button>`
        : `<div style="margin-top:6px;font-size:10px;color:#e53935;font-weight:600">⛔ Make-up period expired (7-day window closed)</div>`;
    } else {
      const mkStatus = (makeup['Status'] || 'Pending').toLowerCase();
      if (mkStatus === 'approved') {
        statusBadge = `<span style="background:#e8f5ee;color:#2d6a4f;font-size:10px;font-weight:700;padding:3px 8px;border-radius:12px">✅ Excused</span>`;
        actionBtns  = `<div style="font-size:10px;color:#2d6a4f;margin-top:4px">Make-up approved by ${makeup['Approved By'] || 'Lifeclass Team'}</div>`;
      } else if (mkStatus === 'denied') {
        statusBadge = `<span style="background:#fdecea;color:#e53935;font-size:10px;font-weight:700;padding:3px 8px;border-radius:12px">❌ Denied</span>`;
        actionBtns  = `<div style="font-size:10px;color:#e53935;margin-top:4px">Reason: ${makeup['Remarks'] || '—'}</div>`;
      } else {
        statusBadge = `<span style="background:#fff5e0;color:#c9960c;font-size:10px;font-weight:700;padding:3px 8px;border-radius:12px">🕐 Pending Review</span>`;
        actionBtns  = `
          <div style="font-size:10px;color:#7a5a00;margin-top:4px;margin-bottom:6px">Reason: ${makeup['Reason'] || '—'}</div>
          <div style="display:flex;gap:6px">
            <button onclick="approveMakeup('${studentId}_${weekNo}','${studentId}','${weekNo}','${name.replace(/'/g,"\\'")}')"
              style="flex:1;background:#2d6a4f;color:#fff;border:none;border-radius:8px;padding:7px;font-size:11px;font-weight:700;cursor:pointer">✅ Approve</button>
            <button onclick="denyMakeup('${studentId}_${weekNo}','${name.replace(/'/g,"\\'")}')"
              style="flex:1;background:#e53935;color:#fff;border:none;border-radius:8px;padding:7px;font-size:11px;font-weight:700;cursor:pointer">❌ Deny</button>
          </div>`;
      }
    }

    return `
      <div style="padding:12px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px">
          <div>
            <strong style="font-size:13px">${name}</strong><br>
            <small style="color:var(--text3)">Week ${weekNo} · Table ${tableNo}</small>
          </div>
          ${statusBadge}
        </div>
        ${deadlineHtml}
        ${actionBtns}
      </div>`;
  }).join('');
}

function openMakeupRequest(studentId, weekNo, name, tableNo) {
  const reason = prompt(`Make-up request for ${name} (Week ${weekNo})\n\nEnter reason / excuse:`);
  if (!reason) return;
  submitMakeupRequest(studentId, weekNo, name, tableNo, reason);
}

async function submitMakeupRequest(studentId, weekNo, name, tableNo, reason) {
  try {
    await apiPost({
      action: 'addMakeup', studentId, weekNo,
      studentName: name, tableNo, reason,
      status: 'Pending',
      requestedBy: APP.currentAdmin?.['Full Name'] || APP.currentFaculty?.['Full Name'] || 'Team',
      timestamp: new Date().toISOString()
    });
    await loadAllData();
    renderMakeup();
    showToast('📋 Make-up request submitted for ' + name);
  } catch(e) { showToast('❌ Failed to submit'); console.error(e); }
}

async function approveMakeup(makeupId, studentId, weekNo, name) {
  const approver = APP.currentAdmin?.['Full Name'] || APP.currentFaculty?.['Full Name'] || 'Lifeclass Team';
  try {
    await apiPost({ action: 'updateMakeup', makeupId, studentId, weekNo, status: 'Approved', approvedBy: approver });
    await loadAllData();
    renderMakeup();
    showToast('✅ Make-up approved for ' + name);
  } catch(e) { showToast('❌ Failed to approve'); console.error(e); }
}

async function denyMakeup(makeupId, name) {
  const reason = prompt(`Deny make-up for ${name}?\n\nReason for denial:`);
  if (!reason) return;
  try {
    await apiPost({ action: 'updateMakeup', makeupId, status: 'Denied', remarks: reason });
    await loadAllData();
    renderMakeup();
    showToast('❌ Make-up denied for ' + name);
  } catch(e) { showToast('❌ Failed to deny'); console.error(e); }
}

// ═══════════════════════════════════════════
// RECORD HOME STATS
// ═══════════════════════════════════════════
function renderRecordStats() {
  const el = document.getElementById('r-stats');
  if (!el) return;
  const activeStudents = APP.students.filter(s => (s["Status"] || "Active").toLowerCase() !== "dropped");
  const totalPaid = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Paid").length;
  el.innerHTML = `
    <div class="stat-card"><div class="stat-val">${activeStudents.length}</div><div class="stat-label">Total Students</div></div>
    <div class="stat-card"><div class="stat-val">${totalPaid}</div><div class="stat-label">Fully Paid</div></div>
  `;
}

// ═══════════════════════════════════════════
// RECORD — PAYMENT
// ═══════════════════════════════════════════
function populatePayStudentSelect() {
  const sel = document.getElementById('pay-student-sel');
  if (!sel) return;
  sel.innerHTML = APP.students.map(s =>
    `<option value="${s["Student ID"]}">${s["Full Name"]} (Table ${s["Table No"]})</option>`
  ).join('');
}

function filterPayStudents() {
  const query = document.getElementById('pay-search')?.value?.toLowerCase() || '';
  const sel   = document.getElementById('pay-student-sel');
  if (!sel) return;
  const filtered = APP.students.filter(s =>
    s["Full Name"].toLowerCase().includes(query) || String(s["Student ID"]).includes(query)
  );
  sel.innerHTML = filtered.map(s =>
    `<option value="${s["Student ID"]}">${s["Full Name"]} (Table ${s["Table No"]})</option>`
  ).join('');
}

async function doAddPayment() {
  const studentId = document.getElementById('pay-student-sel')?.value;
  const amount    = parseFloat(document.getElementById('pay-amount')?.value || 0);
  const type      = document.getElementById('pay-type')?.value || 'Full';
  const notes     = document.getElementById('pay-notes')?.value || '';

  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Please select a student.'); return; }
  if (!amount || amount <= 0) { showToast('⚠️ Enter a valid amount.'); return; }

  const pay     = getStudentPayment(student["Student ID"]);
  const balance = Math.max(0, pay.balance - amount);
  const status  = balance <= 0 ? "Paid" : "Partial";

  try {
    const btn = document.querySelector('#s-r-payment .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    await apiPost({
      action:      "addPayment",
      studentId:   student["Student ID"],
      studentName: student["Full Name"],
      tableNo:     student["Table No"],
      amountPaid:  amount,
      balance:     balance,
      status:      `${status} — ${type}${notes ? ' · ' + notes : ''}`
    });

    showToast(`✅ Payment recorded for ${student["Full Name"]}`);
    document.getElementById('pay-amount').value = '';
    document.getElementById('pay-notes').value  = '';
    await loadAllData();
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to record payment'));
    console.error('doAddPayment error:', err);
  } finally {
    const btn = document.querySelector('#s-r-payment .btn-primary');
    if (btn) { btn.disabled = false; btn.textContent = 'Record Payment'; }
  }
}

// ═══════════════════════════════════════════
// BALANCES SUMMARY
// ═══════════════════════════════════════════
function renderBalancesSummary() {
  const feeEl = document.getElementById('r-total-fee');
  if (feeEl) feeEl.textContent = `₱${APP.totalFee.toLocaleString()}.00`;

  const summaryEl = document.getElementById('r-bal-summary');
  if (!summaryEl) return;

  const paid    = APP.students.filter(s => getStudentPayment(s["Student ID"]).status === "Paid").length;
  const partial = APP.students.filter(s => getStudentPayment(s["Student ID"]).status === "Partial").length;
  const unpaid  = APP.students.filter(s => getStudentPayment(s["Student ID"]).status === "Unpaid").length;

  summaryEl.innerHTML = `
    <div class="stat-card"><div class="stat-val" style="color:var(--green)">${paid}</div><div class="stat-label">Fully Paid</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#e8a020">${partial}</div><div class="stat-label">Partial</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--red,#e53935)">${unpaid}</div><div class="stat-label">Unpaid</div></div>
  `;
}

// ═══════════════════════════════════════════
// LOGIN SYSTEM
// ═══════════════════════════════════════════
const ADMIN_ROLES  = ['director', 'consultant'];
const RECORD_ROLES = ['record', 'recorder'];

function getRoleType(role) {
  const r = (role || '').toLowerCase().trim();
  if (ADMIN_ROLES.some(a  => r.includes(a))) return 'admin';
  if (RECORD_ROLES.some(a => r.includes(a))) return 'record';
  return 'faculty';
}

function findFacultyByCredentials(username, password) {
  return APP.faculty.find(f =>
    String(f["Username"] || '').trim().toLowerCase() === username.trim().toLowerCase() &&
    String(f["Password"] || '').trim() === password.trim()
  ) || null;
}

function isDataEmpty() { return APP.faculty.length === 0; }

function showLoginError(errId, message) {
  const el = document.getElementById(errId);
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
}

function hideLoginError(errId) {
  const el = document.getElementById(errId);
  if (el) el.style.display = 'none';
}

function setLoginLoading(btnEl, loading) {
  if (!btnEl) return;
  btnEl.disabled    = loading;
  btnEl.textContent = loading ? 'Signing in…' : 'Sign in';
}

function doFacultyLogin() {
  const username = document.getElementById('f-login-user')?.value || '';
  const password = document.getElementById('f-login-pass')?.value || '';
  const btn      = document.querySelector('#s-faculty-login .btn-primary');
  hideLoginError('f-login-err');
  if (!username || !password) { showLoginError('f-login-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('f-login-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  setLoginLoading(btn, true);
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) { showLoginError('f-login-err', 'Incorrect username or password.'); setLoginLoading(btn, false); document.getElementById('f-login-pass').value = ''; return; }
    const roleType = getRoleType(person["Role"]);
    if (roleType === 'admin')  { showLoginError('f-login-err', 'Use the Admin portal to sign in.');  setLoginLoading(btn, false); return; }
    if (roleType === 'record') { showLoginError('f-login-err', 'Use the Record portal to sign in.'); setLoginLoading(btn, false); return; }
    APP.currentFaculty = person;
    setLoginLoading(btn, false);
    clearLoginFields('f-login-user', 'f-login-pass');
    populateCreditStudentSelect();
    updateFacultyHome();
    go('s-faculty-home');
  }, 120);
}

function doAdminLogin() {
  const username = document.getElementById('a-login-user')?.value || '';
  const password = document.getElementById('a-login-pass')?.value || '';
  const btn      = document.querySelector('#s-admin-login .btn-primary');
  hideLoginError('a-login-err');
  if (!username || !password) { showLoginError('a-login-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('a-login-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  setLoginLoading(btn, true);
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) { showLoginError('a-login-err', 'Incorrect username or password.'); setLoginLoading(btn, false); document.getElementById('a-login-pass').value = ''; return; }
    const roleType = getRoleType(person["Role"]);
    if (roleType !== 'admin') { showLoginError('a-login-err', 'Your account does not have Admin access.'); setLoginLoading(btn, false); return; }
    APP.currentFaculty = person;
    setLoginLoading(btn, false);
    clearLoginFields('a-login-user', 'a-login-pass');
    updateAdminHomeStats();
    go('s-admin-home');
  }, 120);
}

function doRecordLogin() {
  const username = document.getElementById('r-login-user')?.value || '';
  const password = document.getElementById('r-login-pass')?.value || '';
  const btn      = document.querySelector('#s-record-login .btn-primary');
  hideLoginError('r-login-err');
  if (!username || !password) { showLoginError('r-login-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('r-login-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  setLoginLoading(btn, true);
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) { showLoginError('r-login-err', 'Incorrect username or password.'); setLoginLoading(btn, false); document.getElementById('r-login-pass').value = ''; return; }
    const roleType = getRoleType(person["Role"]);
    if (roleType !== 'record') { showLoginError('r-login-err', 'Your account does not have Record access.'); setLoginLoading(btn, false); return; }
    APP.currentFaculty = person;
    setLoginLoading(btn, false);
    clearLoginFields('r-login-user', 'r-login-pass');
    renderRecordStats();
    go('s-record-home');
  }, 120);
}

function logout() {
  APP.currentFaculty = null;
  go('s-portal');
}

function clearLoginFields(...ids) {
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}