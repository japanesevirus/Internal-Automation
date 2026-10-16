// ==UserScript==
// @name         PoP & QBO Integrated Workflow
// @namespace    Gemini.Accounting.Workflow
// @version      7.13
// @description  Tách hàm createJournalFromTable, tự động nhấn Save sau khi paste dữ liệu.
// @author       Gemini
// @match        https://pop.saigontechnology.vn/*
// @match        https://*.qbo.intuit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';
    // --- CẤU HÌNH ---
    let utils = null;
    const SYNC_KEY = "qbo_pop_syncdata";
    const MAPPING_KEY = "qbo_current_mappings";
    const TARGET_DATE = "20/01/2050";
    const hostname = window.location.hostname;

    const formatNum = (num) => (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function waitForFinplanUtils(timeout = 15000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const u = unsafeWindow && unsafeWindow.FinplanUtils;
                if (u) return resolve(u);
                if (Date.now() - start > timeout) {
                    return reject(new Error('Không tìm thấy FinplanUtils (Finplan_Shared_Library chưa được nạp hoặc đang tắt).'));
                }
                setTimeout(check, 100);
            };
            check();
        });
    }

    // --- HELPER: ĐỊNH DẠNG SỐ TIỀN ---
    const formatCurrency = (num) => (num || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    function calculateTotalDebits(rows) {
        if (!rows) return 0;
        return rows.reduce((sum, row) => sum + (parseFloat(row.dr) || 0), 0);
    }

    function formatDateToQBO(dateInput) {
        if (!dateInput) return null;
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return null;
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }

    function formatDate(d) {
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }

    function UpdatePanelControls(popId, jNo1, txnId1, jNo2, txnId2){
        const updateRow = (idx, jNo, txnId) => {
            const btn = document.getElementById(`btn-t${idx}`);
            const chk = document.getElementById(`chk-t${idx}`);
            if (jNo) {
                document.getElementById(`p-jno-t${idx}`).innerText = jNo || '---';
                document.getElementById(`p-txn-t${idx}`).innerText = txnId || '---';
                if (jNo || txnId){
                    if (chk) chk.style.display = "inline-block";
                    if (btn) {
                        btn.innerText = `J#${jNo} Created`;
                        btn.style.background = "#2ecc71";
                        btn.style.pointerEvents = "none";
                        btn.style.opacity = "0.7";
                    }
                    return true;
                } else {
                    if (chk) chk.style.display = "none";
                    if (btn) {
                        btn.innerText = `Create Table ${idx}`;
                        btn.style.background = "#2ca01c";
                        btn.style.pointerEvents = "auto";
                        btn.style.opacity = "1";
                    }
                }
            }
            return false;
        };
        const hasT1 = updateRow(1, jNo1, txnId1);
        const hasT2 = updateRow(2, jNo2, txnId2);

        // HIỂN THỊ NÚT MASTER CHECK NẾU CÓ CẢ 2
        const masterBtn = document.getElementById('btn-master-check');
        if (hasT1 && hasT2) {
            masterBtn.style.display = "block";
        } else {
            masterBtn.style.display = "none";
        }
        document.getElementById(`qbo-header-name`).innerText = `✥ PoP Master Control [v7.13] - ${popId}`;
    }

    function NoteToMapping(popId, note) {
        let mappings = {};
        let m1 = [note, null, null];
        let m2 = [note, null, null];

        if (note) {
            const trimmedNote = note.trim();
            const simpleNumbersMatch = trimmedNote.match(/^(\d+)\s+(\d+)$/);
            if (simpleNumbersMatch) {
                mappings.T1 = { jNo: simpleNumbersMatch[1], txnId: null };
                mappings.T2 = { jNo: simpleNumbersMatch[2], txnId: null };
                m1 = [simpleNumbersMatch[0], simpleNumbersMatch[1]];
                m2 = [simpleNumbersMatch[0], simpleNumbersMatch[2]];
            } else {
                m1 = note.match(/\[QBO_JNO_T1:\s*(\d+)(?:\s*\|\s*txn:\s*(\d+))?\]/);
                m2 = note.match(/\[QBO_JNO_T2:\s*(\d+)(?:\s*\|\s*txn:\s*(\d+))?\]/);
                if (m1) mappings.T1 = { jNo: m1[1], txnId: m1[2] || null };
                if (m2) mappings.T2 = { jNo: m2[1], txnId: m2[2] || null };
            }
        }

        GM_setValue(MAPPING_KEY, mappings);
        UpdatePanelControls(popId, m1?.[1], m1?.[2], m2?.[1], m2?.[2]);
    }

    function MappingToNote(popId, token, type, jNo, txnId) {
        const syncData = GM_getValue(SYNC_KEY);
        const mappings = GM_getValue(MAPPING_KEY, {});
        if (type && jNo) mappings[`T${type}`] = { jNo, txnId: txnId || null };
        GM_setValue(MAPPING_KEY, mappings);

        let cleanNote = (syncData.note || "").replace(/\s*\[QBO_JNO_T\d:.*?\]/g, "").trim();
        if (mappings.T1) cleanNote += ` [QBO_JNO_T1: ${mappings.T1.jNo}${mappings.T1.txnId ? ' | txn: ' + mappings.T1.txnId : ''}]`;
        if (mappings.T2) cleanNote += ` [QBO_JNO_T2: ${mappings.T2.jNo}${mappings.T2.txnId ? ' | txn: ' + mappings.T2.txnId : ''}]`;

        GM_xmlhttpRequest({
            method: "PUT",
            url: `https://popapi.saigontechnology.vn/api/report/${popId}/reward/savenote`,
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            data: JSON.stringify({ note: cleanNote, popReportId: parseInt(popId) }),
            onload: (res) => {
                if (res.status === 200 || res.status === 204) {
                    syncData.note = cleanNote; GM_setValue(SYNC_KEY, syncData);
                    NoteToMapping(popId, cleanNote);
                }
            }
        });

        UpdatePanelControls(popId, mappings.T1.jNo, mappings.T1.txnId, mappings.T2.jNo, mappings.T2.txnId);
    }

    function setPopToAccountingBooked(popId, token) {
        GM_xmlhttpRequest({
            method: "POST",
            url: `https://popapi.saigontechnology.vn/api/report/${popId}/book-to-accounting`,
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            onload: (res) => {
                if (res.status === 200 || res.status === 204) {

                } else {
                    try {
                        const response = JSON.parse(res.response);
                        alert(`Lỗi khi set status cho PoP. ${response.error.message}`);
                    } catch {
                        alert(`Lỗi khi set status cho PoP.`);
                    }
                }
            }
        });
    }


 /**
 * Chờ cho đến khi một phần tử không còn bị disabled nữa.
 *
 * @param {Element} el - Phần tử cần theo dõi (đã có sẵn reference).
 * @param {number} [timeout=10000] - Thời gian chờ tối đa (ms).
 * @returns {Promise<Element>}
 */
    function waitForEnabled(el, timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (!el.disabled) return resolve(el);

            const observer = new MutationObserver(() => {
                if (!el.disabled) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(el);
                }
            });

            observer.observe(el, { attributes: true, attributeFilter: ['disabled'] });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error('Timeout: phần tử vẫn bị disabled sau ' + timeout + 'ms'));
            }, timeout);
        });
    }

    async function createJournalFromTable(rows, type, btn, syncData, journalDate) {
        try {
            btn.innerText = "⏳ Processing...";
            btn.style.pointerEvents = "none";
            await sleep(1500);
            const pasteBtn = await utils.waitForElement(['button[data-testid="paste_icon"]'], 20000);

            const text = rows.map(r => [r.acc, r.dr, r.cr, r.desc, r.name, "", "", r.cls].join("\t")).join("\n");
            await navigator.clipboard.writeText(text);
            pasteBtn.click();
            await sleep(500);

            await utils.waitForElement(['button[data-testid="paste_icon"]'], 20000);
            const dateInput = document.querySelector('input[data-testid="JOURNAL_ENTRY_txn_date"]');
            dateInput.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(dateInput, journalDate);
            dateInput.dispatchEvent(new Event('input', { bubbles: true }));
            dateInput.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(500);
            dateInput.blur();
            const jNo = document.querySelector('input[data-testid="reference_no"]')?.value || "Unknown";
            const saveBtn = document.querySelector('button[data-testid="save_button"]');
            await waitForEnabled(saveBtn, 30000).catch(() => {});
            saveBtn.click();
            btn.innerText = "🎯 Confirming...";


            const link = await utils.waitForElement(
                ['div[data-testid="toastMessage"] a'],
                20000,
                (a) => a.textContent.trim() === `Journal Entry ${jNo} saved` && /txnId=(\d+)/.test(a.getAttribute('href') || '')
            ).catch(() => null);

            const txnId = link ? link.getAttribute('href').match(/txnId=(\d+)/)[1] : null;

            await sleep(800);
            document.querySelector('button[aria-label="Close"][class*="IconControl-iconControlButton"]')?.click();
            MappingToNote(syncData.popId, syncData.token, type, jNo, txnId);
        } catch (e) {
            btn.innerText = "❌ Error";
            btn.style.pointerEvents = "auto";
        }
    }

/**
 * Lấy giá trị completedDate từ storage
 * @param {Object} [storageData] - (Tùy chọn) Object storage truyền vào trực tiếp. Nếu không truyền sẽ lấy từ localStorage.
 * @return {string|null} Giá trị completedDate hoặc null nếu không tìm thấy.
 */
    function getPoPCompletedDate() {
        try {
            let syncData = GM_getValue(SYNC_KEY);

            const dateStr = syncData?.project?.popStatus?.completedDate;

            // Trả về null nếu dateStr rơi vào null, undefined hoặc chuỗi rỗng
            if (!dateStr) return null;

            const dateObj = new Date(dateStr);

            // Kiểm tra xem chuỗi có parse ra Date hợp lệ hay không (tránh Invalid Date)
            return isNaN(dateObj.getTime()) ? null : dateObj;

        } catch (error) {
            console.error("Lỗi khi lấy popCompletedDate:", error);
            return null;
        }
    }

    function cleanAmount(str) {
        if (!str || str.trim() === "") return 0;
        return parseFloat(str.replace(/[^\d.-]/g, '')) || 0;
    }

    // =========================================================================
    // CORE LOGIC: CompareTableData (v7.13)
    // =========================================================================
    async function CompareTableData(popTableRows, tableName, jNo, jDate = null, offerCorrectjDate = false) {
        await sleep(3000);
        const qboTable = document.querySelector('table.txp-capability-journalAccountTable-SGCvv');
        if (!qboTable) return false;

        let totalErrors = [];

        const qboRows = Array.from(qboTable.querySelectorAll('tbody tr[role="row"]'));
        const validQboRows = qboRows.filter(row => {
            const acc = row.querySelector('[data-testid^="read-only-account-holder-row"]')?.textContent.trim();
            return acc && acc !== "";
        });

        const maxLength = Math.max(popTableRows.length, validQboRows.length);
        for (let i = 0; i < maxLength; i++) {
            const pop = popTableRows[i] || {};
            const qboRow = validQboRows[i];
            if (!qboRow || !pop.acc) {
                totalErrors.push(`❌ Dòng ${i+1}: Thiếu dòng dữ liệu đối ứng`);
                continue;
            }

            const qboData = {
                acc: qboRow.querySelector('[data-testid^="read-only-account-holder-row"]')?.textContent.trim() || "",
                dr: cleanAmount(qboRow.querySelector('[data-testid^="read-only-account-debit-row"]')?.textContent),
                cr: cleanAmount(qboRow.querySelector('[data-testid^="read-only-account-credit-row"]')?.textContent),
                desc: qboRow.querySelector('[data-testid^="read-only-account-description-row"]')?.textContent.trim() || "",
                cls: qboRow.querySelector('[data-testid^="read-only-account-classes-row"]')?.textContent.trim() || ""
            };

            let lineErrors = [];
            if (qboData.acc !== pop.acc) lineErrors.push("Account");
            if (Math.abs(qboData.dr - (pop.dr || 0)) > 0.01) lineErrors.push("Debit");
            if (Math.abs(qboData.cr - (pop.cr || 0)) > 0.01) lineErrors.push("Credit");
            if (qboData.desc.toLowerCase() !== (pop.desc || "").toLowerCase()) lineErrors.push("Description");
            if (qboData.cls.toLowerCase() !== (pop.cls || "").toLowerCase()) lineErrors.push("Class");

            if (lineErrors.length > 0) totalErrors.push(`📍 Dòng ${i+1}: Sai ${lineErrors.join(", ")}`);
        }

        if (jDate) {
            const dateInput = document.querySelector('input[data-testid="JOURNAL_ENTRY_txn_date"]');
            const actualDate = dateInput ? dateInput.value.trim() : "N/A";
            if (actualDate !== jDate) {
                if (totalErrors.length === 0 && offerCorrectjDate){
                    if (dateInput && confirm(`Cập nhật ngày giao dịch thành ${jDate} ?`)) {
                        dateInput.focus();
                        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                        setter.call(dateInput, jDate);
                        dateInput.dispatchEvent(new Event('input', { bubbles: true }));
                        dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                        await sleep(500);
                        document.querySelector('button[data-testid="save_button"]')?.click();
                        await sleep(500);
                    }
                } else {
                    totalErrors.push(`📅 NGÀY CHỨNG TỪ: QBO (${actualDate}) ≠ PoP (${jDate})`);
                }
            }
        }

        if (totalErrors.length === 0) {
            GM_notification({ title: "✅ Khớp 100%", text: `${tableName} chính xác!`, timeout: 3000 });
            return true;
        } else {
            alert(`❌ SAI LỆCH [${tableName}]:\n\n${totalErrors.join("\n")}`);
            return false;
        }
    }

    async function smartSearchJournal(jNo, tableType, offerCorrectjDate = false) {
        var searchInput = document.getElementById('global-search-input');
        if (!searchInput) { alert("Vui lòng mở Search!"); return false; }
        searchInput.focus();

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;

        const eventOptions = { bubbles: true, cancelable: true };
        searchInput.dispatchEvent(new Event('input', eventOptions));
        searchInput.dispatchEvent(new Event('change', eventOptions));
        const enterInit = {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        };

        searchInput.dispatchEvent(new KeyboardEvent('keydown', enterInit));
        searchInput.dispatchEvent(new KeyboardEvent('keypress', enterInit));
        searchInput.dispatchEvent(new KeyboardEvent('keyup', enterInit));

        ///<div class="ResultCategory">
        const foundResultCategory = await utils.waitForElement(['div.ResultCategory'], 8000);
        
        if (!foundResultCategory) return false;

        searchInput = document.getElementById('global-search-input');
        setter.call(searchInput, jNo);
        searchInput.dispatchEvent(new Event('input', eventOptions));


        const found = await utils.waitForElement(['button:has(.SeparatedContent b)'], 8000,
            (btn) => btn.querySelector('.SeparatedContent b')?.textContent.trim() === jNo.toString()
        );

        if (!found) return false
        else found.click();

        const opened = await new Promise(resolve => {
            const start = Date.now();
            const inv = setInterval(() => {
                if (window.location.href.includes('txnId=')) { clearInterval(inv); resolve(true); }
                if (Date.now() - start > 10000) { clearInterval(inv); resolve(false); }
            }, 500);
        });
        if (!opened) return false;

        const syncData = GM_getValue(SYNC_KEY);
        const popRows = (tableType === 1) ? syncData.table1 : syncData.table2;
        const expectedDate = (tableType === 2) ? formatDateToQBO(syncData.project?.endDate) : formatDateToQBO(syncData.project?.popStatus?.completedDate);
        return await CompareTableData(popRows, `Table ${tableType}`, jNo, expectedDate, offerCorrectjDate);
    }

    // =========================================================================
    // UI RENDERER (v7.13)
    // =========================================================================
    if (hostname.includes('qbo.intuit.com')) {
        async function renderQBOPanel(data) {
            let panel = document.getElementById('qbo-auto-filler-panel');
            if (panel) panel.remove();

            panel = document.createElement('div');
            panel.id = 'qbo-auto-filler-panel';
            panel.style = `position:fixed; z-index:100000; background:white; border:2px solid #2ca01c; border-radius:12px; width: 780px; font-family: sans-serif; box-shadow:0 10px 40px rgba(0,0,0,0.4); overflow:hidden; box-sizing: border-box;`;
            const pos = GM_getValue("qbo_panel_pos", { top: 100, left: window.innerWidth - 820 });
            panel.style.top = pos.top + "px"; panel.style.left = pos.left + "px";

            const journalUrl = window.location.href.split('/app/')[0] + '/app/journal';

            panel.innerHTML = `
                <div id="qbo-header" style="background:#2ca01c; color:white; padding:10px 15px; cursor:move; display:flex; justify-content:space-between; align-items:center;">
                    <strong id="qbo-header-name">✥ PoP Master Control [v7.13]</strong>
                    <div style="display:flex; gap:10px; align-items:center;">
                        <button id="btn-clear-sync" title="Clear Sync Data" style="background:rgba(255,255,255,0.2); border:none; color:white; cursor:pointer; font-size:14px; padding:2px 8px; border-radius:4px;">🗑️ Clear</button>
                        <button onclick="this.closest('#qbo-auto-filler-panel').remove()" style="background:none; border:none; color:white; cursor:pointer; font-size:22px;">&times;</button>
                    </div>
                </div>
                <div style="padding:15px; box-sizing: border-box;">
                    <table style="width:100%; border-collapse:collapse; font-size:12px; table-layout: fixed;">
                        <thead>
                            <tr style="border-bottom:2px solid #eee;">
                                <th style="width: 22%; text-align:left;">TABLE NAME</th>
                                <th style="width: 20%; text-align:right;">VALUE (DR)</th>
                                <th style="width: 10%; text-align:center;">JNO</th>
                                <th style="width: 10%; text-align:center;">TXNID</th>
                                <th style="width: 38%; text-align:right;">ACTION</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr style="height: 50px; border-bottom:1px solid #f5f5f5;">
                                <td style="font-weight:bold;">Table 1: Rewards</td>
                                <td align="right">${formatCurrency(calculateTotalDebits(data.table1))}</td>
                                <td align="center" id="p-jno-t1">---</td>
                                <td align="center" id="p-txn-t1">---</td>
                                <td align="right">
                                    <a id="btn-t1" href="${journalUrl}" style="display:inline-block; text-align:center; padding:8px 12px; background:#2ca01c; color:white; border-radius:4px; font-weight:bold; text-decoration:none; cursor:pointer; font-size:11px; border:none;">Create T1</a>
                                    <button id="chk-t1" style="padding:6px 12px; background:#3498db; color:white; border:none; border-radius:4px; cursor:pointer; margin-left:4px; display:none;">🔍 Check</button>
                                </td>
                            </tr>
                            <tr style="height: 50px;">
                                <td style="font-weight:bold;">Table 2: Cost Offset</td>
                                <td align="right">${formatCurrency(calculateTotalDebits(data.table2))}</td>
                                <td align="center" id="p-jno-t2">---</td>
                                <td align="center" id="p-txn-t2">---</td>
                                <td align="right">
                                    <a id="btn-t2" href="${journalUrl}" style="display:inline-block; text-align:center; padding:8px 12px; background:#2ca01c; color:white; border-radius:4px; font-weight:bold; text-decoration:none; cursor:pointer; font-size:11px; border:none;">Create T2</a>
                                    <button id="chk-t2" style="padding:6px 12px; background:#3498db; color:white; border:none; border-radius:4px; cursor:pointer; margin-left:4px; display:none;">🔍 Check</button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <div style="margin-top:15px; border-top: 1px solid #eee; padding-top: 15px;">
                        <button id="btn-master-check" style="width:100%; padding:14px; background:#8e44ad; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer; font-size:13px; display:none;">
                            🚀 FULL SEQUENCE CHECK (T2 → T1)
                        </button>
                    </div>
                </div>`;

            document.body.appendChild(panel);
            const head = panel.querySelector('#qbo-header');
            head.onmousedown = (e) => {
                let ox = e.clientX - panel.offsetLeft, oy = e.clientY - panel.offsetTop;
                document.onmousemove = (e) => { panel.style.left = (e.clientX - ox) + "px"; panel.style.top = (e.clientY - oy) + "px"; };
                document.onmouseup = () => { document.onmousemove = null; GM_setValue("qbo_panel_pos", { top: panel.offsetTop, left: panel.offsetLeft }); };
            };

            panel.querySelector('#btn-master-check').onclick = function() { runSequenceCheck(this); };
            panel.querySelector('#chk-t1').onclick = function() { smartSearchJournal(GM_getValue(MAPPING_KEY).T1.jNo, 1); };
            panel.querySelector('#chk-t2').onclick = function() { smartSearchJournal(GM_getValue(MAPPING_KEY).T2.jNo, 2); };
            panel.querySelector('#btn-t1').onclick = function(e) { if (window.location.href.includes('app/journal')) e.preventDefault(); createJournalFromTable(data.table1, 1, this, data, formatDateToQBO(data.project?.popStatus?.completedDate) ?? TARGET_DATE); };
            panel.querySelector('#btn-t2').onclick = function(e) { if (window.location.href.includes('app/journal')) e.preventDefault(); createJournalFromTable(data.table2, 2, this, data, formatDateToQBO(data.project?.endDate)); };

            panel.querySelector('#btn-clear-sync').onclick = function () {
                if (confirm("Bạn có chắc chắn muốn xóa dữ liệu đồng bộ hiện tại? Panel sẽ đóng lại.")) {
                    GM_setValue(SYNC_KEY, null); // Xóa dữ liệu trong storage
                    panel.remove(); // Đóng panel ngay lập tức
                    GM_notification({ title: "Sync Cleared", text: "Dữ liệu đã được làm mới.", timeout: 2000 });
                }
            };
            NoteToMapping(data.popId, data.note);
        }

        async function runSequenceCheck(btn) {
            const mappings = GM_getValue(MAPPING_KEY, {});
            if (!mappings.T1 || !mappings.T2) return;
            const originalText = btn.innerText;
            btn.innerText = "⏳ Step 1/2: Checking T2...";
            if (await smartSearchJournal(mappings.T2.jNo, 2)) {
                btn.innerText = "⏳ Step 2/2: Checking T1...";
                const popCompletedDate = getPoPCompletedDate();
                if (await smartSearchJournal(mappings.T1.jNo, 1, popCompletedDate != null)) {
                    btn.innerText = "✅ ALL MATCHED!";

                    if (popCompletedDate){
                        if (confirm(`Chuyển Pop sang status Accounting Booked ?`)){
                            const syncData = GM_getValue(SYNC_KEY);
                            setPopToAccountingBooked(syncData.popId, syncData.token);
                        }
                    } else {
                        alert("PoP chưa được completed");
                    }
                }
            }
            await sleep(1500); btn.innerText = originalText;
        }

        (async () => {
            try {
                utils = await waitForFinplanUtils();
            } catch (err) {
                console.error('[PoP QBO Workflow]', err.message);
                return;
            }
            GM_addValueChangeListener(SYNC_KEY, (n, ov, nv) => nv && renderQBOPanel(nv));
            const initData = GM_getValue(SYNC_KEY); if (initData) setTimeout(() => renderQBOPanel(initData), 1500);
        })();
    }

    // =========================================================================
    // LOGIC CHO TRANG POP (NGUỒN)
    // =========================================================================
    if (hostname.includes('saigontechnology.vn')) {
        let mainBtn = null;
        function getClientCode(contractCode) {
            if (!contractCode) return "";
            const match = contractCode.match(/STSSW(\d+)/);
            return (match && match[1]) ? (match[1].length > 3 ? match[1].substring(0, match[1].length - 3) : match[1]) : "";
        }
        function getBearerToken() {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.includes('oidc.user')) {
                    try { return JSON.parse(localStorage.getItem(key)).access_token; } catch (e) { return null; }
                }
            }
            return null;
        }
        async function handleExport() {
            const match = window.location.pathname.match(/\/detail\/(\d+)/);
            if (!match) return;
            const popId = match[1];
            const token = getBearerToken();
            const headers = { 'Authorization': `Bearer ${token}` };
            try {
                const [rewardRes, paymentRes, projectInfoRes] = await Promise.all([
                    fetch(`https://popapi.saigontechnology.vn/api/report/${popId}/reward`, { headers }).then(r => r.json()),
                    fetch(`https://popapi.saigontechnology.vn/api/report/${popId}/client-payments`, { headers }).then(r => r.json()),
                    fetch(`https://popapi.saigontechnology.vn/api/report/${popId}/project-information`, { headers }).then(r => r.json())
                ]);
                let crmClientName = "";
                try {
                    const crmRes = await fetch(`https://crmapi.saigontechnology.vn/api/ContractClient`, { headers }).then(r => r.json());
                    const clientData = crmRes.find(item => item.contractCode === (paymentRes.result?.[0]?.contractCode));
                    if (clientData?.lead) crmClientName = clientData.lead.clientName;
                } catch (e) {}
                if (rewardRes.success) { renderReviewTable(rewardRes.result, paymentRes.result?.[0] || {}, projectInfoRes.result || {}, crmClientName); }
            } catch (err) { console.error(err); }
        }
        function renderReviewTable(res, pay, proj, defaultClientName) {
            if (document.getElementById('pop-review-container')) return;
            const totalDebits = parseFloat(document.querySelector('h6.total-reward')?.innerText.replace(/Total Reward:|[^\d]/g, '').replace(/,/g,'')) || 0;
            const clientCode = getClientCode(pay.contractCode || "");
            const endDate = new Date(proj.endDate || new Date());
            const monthStr = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][endDate.getMonth()];
            const container = document.createElement('div');
            container.id = 'pop-review-container';
            container.style = 'position:fixed; top:0; left:0; width:100%; height:100%; z-index:10000; pointer-events:none;';
            const modal = document.createElement('div');
            modal.id = 'pop-draggable-modal';
            modal.style = 'position:absolute; top:20px; left:30px; width:1250px; background:white; border-radius:8px; box-shadow:0 10px 40px rgba(0,0,0,0.4); font-family:sans-serif; pointer-events:auto; border: 1px solid #ccc; padding-bottom:15px;';
            modal.innerHTML = `
                <div id="pop-header" style="padding:12px; background:#f8f9fa; cursor:move; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #ddd; user-select:none; border-radius:8px 8px 0 0;">
                    <div style="display:flex; align-items:center; gap:15px;">
                        <strong style="font-size:16px;">📊 Accounting Review v2.9</strong>
                        <div id="balance-status" style="font-size:12px; padding:4px 10px; border-radius:4px; font-weight:bold;"></div>
                    </div>
                    <div style="display:flex; align-items:center; gap:12px;">
                        <button id="push-qbo-btn" style="padding:6px 14px; background:#8e44ad; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold; font-size:11px;">🚀 Push to QBO</button>
                        <div style="display:flex; align-items:center; gap:5px;">
                            <label style="font-size:12px; font-weight:bold;">Client Name:</label>
                            <input type="text" id="client-name-input" value="${defaultClientName}" style="padding:4px 8px; border:1px solid #3498db; border-radius:4px; width:180px;">
                        </div>
                        <button id="close-x" style="background:none; border:none; font-size:24px; cursor:pointer; color:#999; line-height:1;">&times;</button>
                    </div>
                </div>
                <div style="padding:15px; max-height:85vh; overflow-y:auto;">
                    <h4 style="margin:0 0 10px 0; color:#2c3e50;">Table 1: Rewards</h4>
                    <table border="1" style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:10px;"><thead style="background:#eee;"><tr><th>ACCOUNT</th><th>DEBITS</th><th>CREDITS</th><th style="width:400px;">DESCRIPTION</th><th>NAME</th><th>CLASS</th></tr></thead><tbody id="table-body-1"></tbody></table>
                    <div style="display:flex; justify-content:flex-end; gap:8px; margin-bottom:25px;"><button id="copy-1-only" style="padding:7px 15px; background:#27ae60; color:white; border-radius:4px; font-size:11px; font-weight:bold; border:none; cursor:pointer;">Copy Table 1</button><button id="copy-1-close" style="padding:7px 15px; background:#2980b9; color:white; border-radius:4px; font-size:11px; font-weight:bold; border:none; cursor:pointer;">Copy & Close</button></div>
                    <h4 style="margin:0 0 10px 0; color:#2c3e50;">Table 2: Cost Offset</h4>
                    <table border="1" style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:10px;"><thead style="background:#eee;"><tr><th>ACCOUNT</th><th>DEBITS</th><th>CREDITS</th><th style="width:400px;">DESCRIPTION</th><th>NAME</th><th>CLASS</th></tr></thead><tbody id="table-body-2"></tbody></table>
                    <div style="display:flex; justify-content:flex-end; gap:8px;"><button id="copy-2-only" style="padding:7px 15px; background:#27ae60; color:white; border-radius:4px; font-size:11px; font-weight:bold; border:none; cursor:pointer;">Copy Table 2</button><button id="copy-2-close" style="padding:7px 15px; background:#2980b9; color:white; border-radius:4px; font-size:11px; font-weight:bold; border:none; cursor:pointer;">Copy & Close</button></div>
                </div>`;



            container.appendChild(modal); document.body.appendChild(container);

            const pos = GM_getValue("pop_review_pos", { top: 100, left: window.innerWidth - 820 });
            container.style.top = pos.top + "px"; container.style.left = pos.left + "px";

            let data1 = [], data2 = [];
            const t1Body = modal.querySelector('#table-body-1'), t2Body = modal.querySelector('#table-body-2'), balanceStatus = modal.querySelector('#balance-status');
            const updateUI = () => {
                const clientName = (modal.querySelector('#client-name-input').value || "[Client]")?.trim();
                const baseDesc = `Pop ${res.popReportId} - ${clientCode} ${clientName}:${proj.projectName} ${monthStr} ${endDate.getFullYear()}`;
                const classVal = `${clientCode} ${clientName}:${proj.projectName}`;
                data1 = []; data2 = []; let totalCr = 0;
                data1.push({ acc: "BS315 PoP Withholding:Waiting for release", dr: totalDebits.toFixed(2), cr: "", desc: baseDesc, name: "", cls: classVal });
                const addT1 = (acc, val, suffix, name) => { if (parseFloat(val || 0) > 0) { data1.push({ acc, dr: "", cr: parseFloat(val).toFixed(2), desc: suffix ? `${baseDesc} ${suffix}` : baseDesc, name, cls: classVal }); totalCr += parseFloat(val); } };
                const pcCode = res.projectCoordinator?.empCode || "";
                addT1(`BS315 PoP Withholding:PW ${res.programManager?.empCode || ''}`, res.programManagerReward, "(PgM Reward)", res.programManager?.empCode);
                addT1(`BS315 PoP Withholding:PW ${pcCode}`, res.pcReward, "(PM Reward)", pcCode);
                addT1(`BS315 PoP Withholding:PW ${res.teamLeader?.empCode || ''}`, res.leaderReward, "(Team Leader Reward)", res.teamLeader?.empCode);
                addT1("BS315 PoP Withholding:FM Rewards", res.functionalManagerReward, "", "");
                addT1("BS315 Salary Review Fund", res.salaryReviewFund, "", "");
                addT1("BS315 PoP Withholding:PW Team building", res.teamBuildingBudget, "", pcCode);
                const pwSDC = (res.popRewardDetails || []).reduce((sum, item) => sum + (item.reward || 0), 0);
                addT1("BS315 PoP Withholding:PW SDC", pwSDC, "", "");
                data2 = [{ acc: "BS315 PoP Withholding:Waiting for release", dr: "", cr: totalDebits.toFixed(2), desc: baseDesc, name: "", cls: classVal }, { acc: "Cost of labour - Development Team:Bonus - Dev Team:PoP -Reward based on project profit", dr: totalDebits.toFixed(2), cr: "", desc: baseDesc, name: "", cls: classVal }];
                const toRow = r => `<tr><td style="padding:4px;">${r.acc}</td><td align="right">${r.dr?formatNum(parseFloat(r.dr)):''}</td><td align="right">${r.cr?formatNum(parseFloat(r.cr)):''}</td><td>${r.desc}</td><td>${r.name||''}</td><td>${r.cls}</td></tr>`;
                t1Body.innerHTML = data1.map(toRow).join(''); t2Body.innerHTML = data2.map(toRow).join('');
                const diff = Math.abs(totalDebits - totalCr); balanceStatus.innerHTML = diff < 0.01 ? `✅ Balanced` : `⚠️ Unbalanced!`; balanceStatus.style.background = diff < 0.01 ? "#d4edda" : "#f8d7da";
            };
            updateUI();
            modal.querySelector('#client-name-input').oninput = updateUI;
            modal.querySelector('#close-x').onclick = () => container.remove();
            const copyToClipboard = async (rows, btn) => { const text = rows.map(r => [r.acc, r.dr, r.cr, r.desc, r.name, "", "", r.cls].join("\t")).join("\n"); await navigator.clipboard.writeText(text); if (btn) { const old = btn.innerHTML; btn.innerHTML = '✅ Copied!'; setTimeout(() => btn.innerHTML = old, 2000); } };
            modal.querySelector('#copy-1-only').onclick = function() { copyToClipboard(data1, this); };
            modal.querySelector('#copy-1-close').onclick = async () => { await copyToClipboard(data1); container.remove(); };
            modal.querySelector('#copy-2-only').onclick = function() { copyToClipboard(data2, this); };
            modal.querySelector('#copy-2-close').onclick = async () => { await copyToClipboard(data2); container.remove(); };
            modal.querySelector('#push-qbo-btn').onclick = function() {
                updateUI();
                GM_setValue(SYNC_KEY, { timestamp: Date.now(), popId: res.popReportId, note: document.querySelector('textarea[name="note"]')?.value || "", table1: data1, table2: data2, token: getBearerToken(), project:proj });
                GM_notification({ title: "Sync", text: "Data pushed to QBO!", timeout: 2000 });
                this.innerHTML = '✅ Pushed'; setTimeout(() => { this.innerHTML = '🚀 Push to QBO'; }, 2000);
            };
            let isDragging = false, offset = [0,0];
            const head = container.querySelector('#pop-header');
            head.onmousedown = (e) => {
                let ox = e.clientX - container.offsetLeft, oy = e.clientY - container.offsetTop;
                document.onmousemove = (e) => { container.style.left = (e.clientX - ox) + "px"; container.style.top = (e.clientY - oy) + "px"; };
                document.onmouseup = () => { document.onmousemove = null; document.onmouseup =null; GM_setValue("pop_review_pos", { top: container.offsetTop, left: container.offsetLeft }); };
            };
            // modal.querySelector('#pop-header').onmousedown = (e) => {
            //     if(!['INPUT','BUTTON'].includes(e.target.tagName)) { isDragging = true; offset = [modal.offsetLeft - e.clientX, modal.offsetTop - e.clientY]; }
            // };
            // document.onmousemove = (e) => { if (isDragging) { modal.style.left = (e.clientX + offset[0]) + 'px'; modal.style.top = (e.clientY + offset[1]) + 'px'; }};
            // document.onmouseup = () => isDragging = false;
        }
        setInterval(() => {
            // 1. Lấy đường dẫn URL hiện tại (ví dụ: /pop-reports/detail/123?step=3)
            const currentPath = window.location.pathname + window.location.search;

            // 2. Định nghĩa Regex để kiểm tra cấu trúc: pop-reports/detail/{number}?step=3
            // \d+ đại diện cho {number} (một hoặc nhiều chữ số)
            const pattern = /pop-reports\/detail\/\d+\?step=3/;

            // 3. Tìm element theo ID
            const exportBtn = document.getElementById('pop-main-export-btn');

            if (pattern.test(currentPath) && !exportBtn){
                const btn = document.createElement('button');
                btn.id = 'pop-main-export-btn';
                btn.innerHTML = '📊 Export Accounting Table';
                btn.style = 'position:fixed; top:15px; right:15px; z-index:9999; padding:10px 20px; background:#27ae60; color:white; border:none; border-radius:25px; cursor:pointer; font-weight:bold;';
                btn.onclick = handleExport;
                document.body.appendChild(btn);
            } else {
                if (exportBtn) {
                    if (pattern.test(currentPath)) {
                        // Hiển thị nếu khớp URL
                        exportBtn.style.display = 'block';
                    } else {
                        // Ẩn nếu không khớp
                        exportBtn.style.display = 'none';
                    }
                }
            }
        }, 1000);
    }
})();