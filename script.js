// 1. መጀመሪያ ሳጥኑን የሚዘጋውን ፈንክሽን እንጨምር (ይህ ካልኖረ ኮዱ ይቆማል)
function closeSendMsg() {
  const overlay = document.getElementById("sendMsgOverlay");
  const modal = document.getElementById("sendMsgModal");
  if(overlay) overlay.classList.remove("active");
  if(modal) modal.classList.remove("active");
  const input = document.getElementById("smmInput");
  if(input) input.value = ""; 
}
window.closeSendMsg = closeSendMsg;

// 2. መልዕክት የሚልከው ፈንክሽን (በጥንቃቄ የተስተካከለ)
async function sendAdminMsg() {
  const inputEl = document.getElementById("smmInput");
  const text = inputEl ? inputEl.value.trim() : "";

  // ተጠቃሚው መመረጡን እና ጽሁፍ መኖሩን ቼክ እናድርግ
  if (!text) {
    toast("⚠ እባክዎ መልዕክት ይጻፉ!");
    return;
  }
  if (typeof _currentMsgUid === 'undefined' || !_currentMsgUid) {
    toast("❌ ስህተት፡ ተጠቃሚው አልተመረጠም!");
    return;
  }

  try {
    // እዚህ ጋር 'push' በመጠቀም ለእያንዳንዱ መልዕክት አዲስ ID እንሰጣለን
    // መስመሩን በትክክል ተመልከት፡ users/USER_ID/notifications
    const notifRef = ref(db, "users/" + _currentMsgUid + "/notifications");
    const newMsgRef = push(notifRef); 

    await set(newMsgRef, {
      from: "Alpha Bingo Admin",
      message: text,
      read: false,
      ts: Date.now() // ወይም serverTimestamp()
    });

    toast("✅ መልዕክቱ በትክክል ተልኳል!");
    closeSendMsg(); // አሁን በትክክል ይዘጋል
  } catch(e) {
    console.error("Msg Error:", e);
    toast("❌ ስህተት ተፈጥሯል: " + e.message);
  }
}
window.sendAdminMsg = sendAdminMsg;
