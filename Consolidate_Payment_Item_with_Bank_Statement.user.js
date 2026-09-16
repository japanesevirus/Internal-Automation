// ==UserScript==
// @name         Consolidate Payment Item with Bank Statement
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Cập nhật Equivalent Amount và chuyển tag "Waiting for bank statement" -> "Waiting for bank statement ► Checked" hàng loạt cho danh sách Payment Item
// @author       Claude
// @match        https://finplan.saigontechnology.vn/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================================
     *  CONFIG
     *  - BASE_URL: gốc URL của hệ thống Finplan, dùng để build link tới từng Payment Item.
     *  - JOB_STORAGE_KEY: key localStorage lưu trạng thái job đang chạy (danh sách id,
     *    dữ liệu đã parse của từng dòng, vị trí đang xử lý, log kết quả từng item). Nhờ lưu ở
     *    localStorage nên job có thể "sống sót" qua nhiều lần trang reload (khi script tự
     *    chuyển sang item kế tiếp).
     *  - MODAL_POSITION_KEY: key localStorage lưu vị trí (left/top) hộp thoại sau khi user
     *    kéo, để hộp thoại không bị "nhảy" về vị trí mặc định mỗi lần trang tự tải lại.
     *  - TAG_SOURCE / TAG_TARGET: tên chính xác (đã chuẩn hoá khoảng trắng) của 2 tag cần
     *    thao tác. Phải khớp tuyệt đối với text hiển thị trong dropdown Tags trên form.
     * ========================================================================= */
    const BASE_URL = 'https://finplan.saigontechnology.vn';
    const JOB_STORAGE_KEY = 'fpcb_job_v1';
    const MODAL_POSITION_KEY = 'fpcb_modal_position_v1';
    const BUTTON_ID = 'consolidate-payment-bank-statement';
    const TAG_SOURCE = 'Waiting for bank statement';
    const TAG_TARGET = 'Waiting for bank statement ► Checked';

    /**
     * Chờ cho tới khi unsafeWindow.FinplanUtils (thư viện dùng chung, nạp bởi
     * Finplan_Shared_Library.user.js) sẵn sàng. Tampermonkey không đảm bảo thứ tự
     * chạy giữa các userscript nên ta chủ động poll thay vì giả định thứ tự nạp.
     * @param {number} timeout - thời gian chờ tối đa (ms)
     * @returns {Promise<object>} đối tượng FinplanUtils
     */
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

    // Đối tượng thư viện dùng chung; gán 1 lần trong init() sau khi waitForFinplanUtils() resolve.
    let utils = null;

    /* =========================================================================
     *  REGISTRY ĐỊNH DẠNG DÒNG INPUT  (phần thiết kế để MỞ RỘNG được)
     *
     *  Mỗi dòng người dùng nhập có thể theo nhiều "định dạng" khác nhau. Toàn bộ phần
     *  còn lại của script (parse input, xử lý item, vẽ bảng tiến trình) chỉ làm việc
     *  thông qua 3 bảng tra cứu bên dưới, KHÔNG hard-code cho một định dạng cụ thể.
     *
     *  ➜ Thêm một định dạng dòng mới về sau chỉ cần:
     *      1. Thêm 1 entry vào LINE_FORMATS   (cách nhận diện + parse dòng)
     *      2. Thêm 1 hàm vào FORMAT_PROCESSORS (quy trình tự động cho định dạng đó)
     *      3. Thêm 1 mảng vào FORMAT_STAGES    (các cột trạng thái hiển thị trong bảng)
     *  Không phải sửa parseInput / processCurrentItem / renderProgressView.
     *
     *  taskObject (kết quả parse của 1 dòng) LUÔN có tối thiểu:
     *      { format: <id định dạng>, id: <payment item id, chuỗi số> }
     *  cộng thêm các field riêng của định dạng (ví dụ equivalentAmount).
     * ========================================================================= */

    const LINE_FORMATS = [
        {
            id: 'equivalent-amount',
            // Mô tả ngắn gọn hiển thị ở view nhập liệu để user biết cú pháp mong đợi.
            label: '#<payment item id> <Equivalent Amount>',
            /**
             * Thử parse 1 dòng theo định dạng này.
             * @param {string} line - đã được trim 2 đầu bởi parseInput
             * @returns {object|null} taskObject nếu khớp, null nếu dòng không thuộc định dạng này
             */
            parse(line) {
                // #<id> <amount>. Dấu # tuỳ chọn. Các giá trị cách nhau bởi >=1 ký tự
                // whitespace bất kỳ (space, tab, ...). Phần amount là cụm còn lại của dòng.
                const m = line.match(/^#?\s*(\d+)\s+(\S[\s\S]*?)\s*$/);
                if (!m) return null;
                const rawAmount = m[2].trim();
                // Equivalent Amount chỉ chấp nhận chữ số, dấu phẩy, dấu chấm (phân tách nghìn/thập phân).
                if (!/^[\d.,]+$/.test(rawAmount)) return null;
                return { format: 'equivalent-amount', id: m[1], equivalentAmount: rawAmount };
            },
        },
    ];

    // Quy trình xử lý tự động cho từng định dạng: { <formatId>: async function(entry, job) }.
    // Khai báo sau khi các hàm processXxx được định nghĩa (hoisting của function declaration).
    const FORMAT_PROCESSORS = {
        'equivalent-amount': processEquivalentAmountItem,
    };

    // Các cột (giai đoạn) hiển thị trong bảng tiến trình, theo từng định dạng.
    // key phải trùng với key trong entry.stages mà processor ghi vào.
    const FORMAT_STAGES = {
        'equivalent-amount': [
            { key: 'amount', label: '1. Equivalent Amount' },
            { key: 'tag', label: '2. Tags' },
            { key: 'save', label: '3. Save' },
        ],
    };

    /** Danh sách key giai đoạn của 1 định dạng (để khởi tạo entry.stages, đánh dấu skip hàng loạt...). */
    function stageKeysOf(format) {
        return (FORMAT_STAGES[format] || []).map((s) => s.key);
    }

    /**
     * Parse toàn bộ text người dùng nhập thành danh sách task + danh sách dòng không hợp lệ +
     * danh sách payment item id bị nhập trùng.
     * - Tách theo dòng, bỏ dòng trắng.
     * - Mỗi dòng thử lần lượt từng định dạng trong LINE_FORMATS, định dạng đầu tiên khớp thắng.
     * - Dòng không khớp định dạng nào -> đưa vào invalidLines để cảnh báo (không chặn).
     * - Nếu MỘT payment item id xuất hiện ở >=2 dòng -> đưa vào duplicateIds. Đây là LỖI chặn:
     *   nơi gọi (nút "Bắt đầu") phải từ chối chạy khi duplicateIds không rỗng. `tasks` vẫn chỉ
     *   giữ lần xuất hiện đầu tiên của mỗi id để preview hiển thị được số lượng.
     * @returns {{
     *   tasks: object[],
     *   invalidLines: {lineNo:number, text:string}[],
     *   duplicateIds: {id:string, lineNos:number[]}[]
     * }}
     */
    function parseInput(rawText) {
        const lines = (rawText || '').split(/\r?\n/);
        const tasks = [];
        const invalidLines = [];
        const seen = new Set();
        const idToLineNos = new Map(); // id -> [số dòng 1-based đã xuất hiện]

        lines.forEach((rawLine, idx) => {
            const line = rawLine.trim();
            if (!line) return;

            let parsed = null;
            for (const fmt of LINE_FORMATS) {
                parsed = fmt.parse(line);
                if (parsed) break;
            }

            if (!parsed || !parsed.id) {
                invalidLines.push({ lineNo: idx + 1, text: line });
                return;
            }

            // Ghi nhận mọi lần id xuất hiện để phát hiện trùng.
            const lineNos = idToLineNos.get(parsed.id) || [];
            lineNos.push(idx + 1);
            idToLineNos.set(parsed.id, lineNos);

            if (seen.has(parsed.id)) return; // đã có task cho id này -> chỉ giữ lần đầu
            seen.add(parsed.id);
            tasks.push(parsed);
        });

        const duplicateIds = [];
        idToLineNos.forEach((lineNos, id) => {
            if (lineNos.length > 1) duplicateIds.push({ id, lineNos });
        });

        return { tasks, invalidLines, duplicateIds };
    }

    /* =========================================================================
     *  Job state (localStorage) - dùng để "sống sót" qua các lần reload trang
     *  {
     *    ids: string[],              // payment item id, đúng thứ tự xử lý
     *    tasks: { [id]: taskObject },// dữ liệu đã parse của từng dòng (format + field riêng)
     *    index: number,              // vị trí item đang xử lý trong ids
     *    stopped: boolean,           // user đã bấm "Dừng lại"
     *    createdAt: number,
     *    log: [{
     *      id: string,
     *      format: string,
     *      status: 'pending'|'processing'|'success'|'skipped'|'error', // tổng hợp của item
     *      stages: { [stageKey]: { status: 'pending'|'skipped'|'success'|'error', message } }
     *    }]
     *  }
     *  Mỗi item được xử lý qua nhiều GIAI ĐOẠN độc lập (xem FORMAT_STAGES). Mỗi giai đoạn ghi
     *  kết quả riêng vào `stages`. `status` cấp item là tổng hợp: 'error' nếu có ít nhất 1 giai
     *  đoạn lỗi, còn lại 'success' (kể cả khi có giai đoạn bị 'skipped').
     * ========================================================================= */

    /** Đọc job đang lưu trong localStorage (nếu có). Trả về null nếu không có/parse lỗi. */
    function loadJob() {
        try {
            const raw = localStorage.getItem(JOB_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Ghi đè toàn bộ job hiện tại vào localStorage.
     *
     * `stopped` được xử lý như một cờ MỘT CHIỀU: vòng xử lý item đang chạy giữ một tham chiếu
     * `job` cũ trong bộ nhớ (từ lần loadJob() ở processCurrentItem) và gọi saveJob() nhiều lần;
     * nếu trong lúc đó người dùng bấm "Dừng lại" (handler đọc job qua loadJob() KHÁC, set
     * stopped=true rồi lưu), thì các lần saveJob() sau của vòng xử lý sẽ ghi đè stopped về false
     * và job không bao giờ dừng. Vì vậy trước khi ghi, đọc lại bản trong localStorage: nếu bản
     * đó đã stopped thì ép job.stopped = true. Cờ chỉ được gỡ khi clearJob() (bắt đầu job mới).
     */
    function saveJob(job) {
        try {
            const raw = localStorage.getItem(JOB_STORAGE_KEY);
            if (raw) {
                const prev = JSON.parse(raw);
                if (prev && prev.stopped) {
                    job.stopped = true;
                    // Giữ luôn stopMode ('now' | 'after-current') mà handler nút vừa ghi, để vòng
                    // xử lý (giữ job cũ) không xoá mất chế độ dừng.
                    if (prev.stopMode) job.stopMode = prev.stopMode;
                }
            }
        } catch (e) {
            // Bỏ qua lỗi đọc/parse - vẫn ghi bản job mới bên dưới.
        }
        localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(job));
    }

    /** Xoá job khỏi localStorage (dùng khi user đóng job đã hoàn tất hoặc bắt đầu job mới). */
    function clearJob() {
        localStorage.removeItem(JOB_STORAGE_KEY);
    }

    /**
     * Kiểm tra job đã kết thúc hay chưa: hết danh sách id để xử lý, hoặc user đã bấm "Dừng lại".
     * Job null cũng được coi là "đã kết thúc" để các nơi gọi hàm này không cần check null riêng.
     */
    function isJobFinished(job) {
        return !job || job.index >= job.ids.length || job.stopped;
    }

    /* =========================================================================
     *  Helpers URL / text
     * ========================================================================= */

    /** Build URL trang edit của 1 payment item từ id. */
    function getExpectedUrl(id) {
        return `${BASE_URL}/purchase-orders/payment-items/${id}`;
    }

    /** Lấy payment item id từ URL hiện tại (null nếu trang hiện tại không phải trang edit item). */
    function getCurrentItemIdFromUrl() {
        const m = location.pathname.match(/\/purchase-orders\/payment-items\/(\d+)/);
        return m ? m[1] : null;
    }

    /** Chuẩn hoá text: gộp mọi khoảng trắng/xuống dòng liên tiếp thành 1 space rồi trim 2 đầu. */
    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    /* =========================================================================
     *  Xử lý DOM của form Payment Item / Tags dropdown / Equivalent Amount
     * ========================================================================= */

    /** Lấy element gốc (.sts-dropdown) của dropdown Tags trên form (không phải dropdown Owner). */
    function getTagsDropdownRoot() {
        return document.querySelector('app-sts-dropdown-list[placeholder="Select Tags"] .sts-dropdown');
    }

    /**
     * Đọc danh sách tên tag đang được chọn, thông qua phần tóm tắt `.sts-dropdown__selected-items`
     * (phần chip hiển thị ngay cả khi dropdown đang đóng) - không cần mở dropdown để đọc.
     * Dùng để quyết định nhanh: item này có cần đổi tag hay không, trước khi tốn công mở dropdown.
     */
    function getSelectedTagTexts(dropdownRoot) {
        const container = dropdownRoot.querySelector('.sts-dropdown__selected-items');
        if (!container) return [];
        return Array.from(container.querySelectorAll('span'))
            .map((el) => normalizeText(el.textContent).replace(/,$/, '').trim())
            .filter(Boolean);
    }

    /**
     * Bật/tắt trạng thái chọn của 1 tag bằng cách click trực tiếp vào checkbox trong danh sách
     * đầy đủ `.select-list li` (chỉ tồn tại khi dropdown đang MỞ). Đây là cách thao tác đáng tin
     * cậy nhất: gọi `checkbox.click()` (qua utils.simulateClick) sẽ dùng đúng cơ chế toggle mặc
     * định của trình duyệt cho input[type=checkbox], thay vì bấm vào icon "x" ở khu vực tóm tắt.
     *
     * @param {Element} dropdownRoot - element .sts-dropdown (dropdown Tags đang mở)
     * @param {string} exactText - tên tag cần khớp chính xác (đã normalize)
     * @param {boolean} desiredChecked - trạng thái checked mong muốn sau khi gọi hàm
     * @returns {boolean} true nếu tìm thấy tag trong danh sách (bất kể có cần click hay không)
     */
    function setTagChecked(dropdownRoot, exactText, desiredChecked) {
        const items = dropdownRoot.querySelectorAll('.content .select-list li label');
        for (const label of items) {
            const text = normalizeText(label.textContent);
            if (text === exactText) {
                const checkbox = label.querySelector('input[type="checkbox"]');
                if (checkbox) {
                    // Chỉ click khi trạng thái hiện tại khác mong muốn, tránh toggle ngược lại.
                    if (checkbox.checked !== desiredChecked) {
                        utils.simulateClick(checkbox);
                    }
                    return true;
                }
            }
        }
        return false;
    }

    /** Tìm nút "Save" (không phải "Save & Close") trong form payment item, dựa theo text hiển thị. */
    function findSaveButton() {
        const buttons = document.querySelectorAll('app-payment-item-form button.btn.btn-primary');
        for (const btn of buttons) {
            if (normalizeText(btn.textContent) === 'Save') return btn;
        }
        return null;
    }

    /**
     * Tìm 1 nút bấm trong 1 hộp thoại xác nhận, so khớp CHÍNH XÁC text hiển thị (đã trim).
     * Hệ thống dùng nhiều component modal khác nhau; ở script này chỉ cần modal xác nhận Save
     * là `app-sts-confirm-modal` (nút "Yes"), nhưng vẫn giữ tham số rootSelector để nhất quán
     * với Mark_Items_Completed và dễ mở rộng.
     *
     * @param {string} rootSelector - selector của component modal (ví dụ 'app-sts-confirm-modal')
     * @param {string} exactText - text hiển thị cần khớp chính xác trên nút (ví dụ 'Yes')
     */
    function findConfirmModalButton(rootSelector, exactText) {
        const buttons = document.querySelectorAll(`${rootSelector} button.btn.btn-primary`);
        for (const btn of buttons) {
            if (normalizeText(btn.textContent) === exactText) return btn;
        }
        return null;
    }

    /** Lấy input Equivalent Amount trên form (field name="equivalentAmount" trong app-payment-item-form). */
    function getEquivalentAmountInput() {
        return document.querySelector('app-payment-item-form input[name="equivalentAmount"]');
    }

    /**
     * Ghi giá trị mới vào field Equivalent Amount rồi bắn các sự kiện cần thiết để Angular +
     * directive `numericdecimal` nhận biết giá trị đã đổi (giống pattern cleanQuotesInput trong
     * Mark_All_as_Paid_Clean_Quotes.user.js).
     *
     * @param {HTMLInputElement} input
     * @param {string} value - giá trị Equivalent Amount người dùng cung cấp (giữ nguyên định dạng)
     * @returns {{before: string, after: string}} giá trị trước & sau khi ghi (đọc lại từ DOM)
     */
    function setEquivalentAmount(input, value) {
        const before = input.value;

        input.focus();
        input.value = value;
        // 'input' quan trọng nhất cho Angular; thêm 'change' + 'blur' để directive format/validate chạy.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));

        return { before, after: input.value };
    }

    /* =========================================================================
     *  Xử lý 1 Payment Item theo định dạng 'equivalent-amount'
     * ========================================================================= */

    /**
     * Quy trình tự động cho định dạng `#<payment item id> <Equivalent Amount>`, chạy trên trang
     * edit của item đang được job trỏ tới (job.ids[job.index]). Gồm 3 GIAI ĐOẠN tách biệt, mỗi
     * giai đoạn ghi log riêng vào entry.stages.<key> với status 'pending'|'skipped'|'success'|'error':
     *
     *   1. `amount` - Chờ field Equivalent Amount xuất hiện, ghi giá trị mới + bắn event. Nếu
     *                 không tìm thấy field -> 'error', bỏ qua 2 giai đoạn sau.
     *   2. `tag`    - Đọc tag hiện tại (không cần mở dropdown). Nếu KHÔNG có tag
     *                 "Waiting for bank statement" -> 'skipped' (vẫn tiếp tục sang giai đoạn Save
     *                 để lưu Equivalent Amount). Nếu CÓ -> mở dropdown, bỏ chọn tag nguồn, chọn
     *                 tag đích (nếu chưa có), đóng dropdown -> 'success'. Lỗi -> 'error', bỏ qua Save.
     *   3. `save`   - Bấm nút "Save", chờ hộp thoại "Update Confirm" (app-sts-confirm-modal), bấm
     *                 "Yes", chờ modal đóng + overlay loading tan, đọc toast Success/Error.
     *
     * Nguyên tắc "chuỗi domino": giai đoạn 'error' khiến các giai đoạn SAU bị 'skipped' kèm lý do,
     * và entry.status = 'error'. Nếu không giai đoạn nào lỗi -> entry.status = 'success' (kể cả khi
     * giai đoạn 'tag' bị 'skipped'). Hàm KHÔNG throw ra ngoài - luôn gọi advanceJob() ở cuối.
     */
    async function processEquivalentAmountItem(entry, job) {
        const task = job.tasks[entry.id];

        const setStage = (stageKey, status, message) => {
            entry.stages[stageKey] = { status, message: message || '' };
        };
        const persist = () => {
            saveJob(job);
            renderModal();
        };

        // "Dừng ngay": user đã bấm Dừng lại và chọn chế độ 'now' -> bỏ dở item hiện tại.
        const isStopNow = () => {
            const j = loadJob();
            return !!(j && j.stopped && j.stopMode === 'now');
        };
        // Đánh dấu các giai đoạn chưa chạy là 'skipped' rồi persist. KHÔNG gọi advanceJob ->
        // job.index không tăng, không điều hướng sang item kế (job coi như đã dừng qua isJobFinished).
        const bailStopNow = () => {
            stageKeysOf(entry.format).forEach((key) => {
                const st = entry.stages[key];
                if (!st || st.status === 'pending') {
                    entry.stages[key] = { status: 'skipped', message: 'Đã dừng ngay theo yêu cầu, chưa xử lý.' };
                }
            });
            if (!entry.status || entry.status === 'processing') entry.status = 'skipped';
            persist();
        };

        if (!task || typeof task.equivalentAmount !== 'string') {
            setStage('amount', 'error', 'Thiếu dữ liệu Equivalent Amount đã parse cho item này.');
            setStage('tag', 'skipped', 'Bỏ qua vì giai đoạn 1 (Equivalent Amount) bị lỗi.');
            setStage('save', 'skipped', 'Bỏ qua vì giai đoạn 1 (Equivalent Amount) bị lỗi.');
            entry.status = 'error';
            persist();
            advanceJob(job);
            return;
        }

        // Người dùng có thể đã bấm "Dừng lại" + "dừng ngay" ngay khi trang này vừa mở.
        if (isStopNow()) { bailStopNow(); return; }

        // ================= GIAI ĐOẠN 1: Ghi Equivalent Amount ================= //
        let amountOk = false;
        try {
            // Khoảng nghỉ nhỏ để Angular kịp hoàn tất render ban đầu sau khi trang vừa load.
            await utils.sleep(400);
            if (isStopNow()) { bailStopNow(); return; }

            await utils.waitForElement(['app-payment-item-form input[name="equivalentAmount"]'], 25000);
            const input = getEquivalentAmountInput();
            if (!input) throw new Error('Không tìm thấy field Equivalent Amount trên form.');

            const { before, after } = setEquivalentAmount(input, task.equivalentAmount);
            await utils.sleep(300);

            setStage('amount', 'success', `Đã đặt Equivalent Amount: "${before}" → "${after}" (yêu cầu: "${task.equivalentAmount}").`);
            amountOk = true;
        } catch (err) {
            setStage('amount', 'error', (err && err.message) || String(err));
            amountOk = false;
        }
        persist();

        if (!amountOk) {
            setStage('tag', 'skipped', 'Bỏ qua vì giai đoạn 1 (Equivalent Amount) bị lỗi.');
            setStage('save', 'skipped', 'Bỏ qua vì giai đoạn 1 (Equivalent Amount) bị lỗi.');
            entry.status = 'error';
            persist();
            advanceJob(job);
            return;
        }

        if (isStopNow()) { bailStopNow(); return; }

        // ================= GIAI ĐOẠN 2: Đổi tag (có điều kiện) ================= //
        let tagError = false;
        try {
            const dropdownRootSelector = 'app-sts-dropdown-list[placeholder="Select Tags"] .sts-dropdown';
            await utils.waitForElement([dropdownRootSelector], 15000);
            const dropdownRoot = getTagsDropdownRoot();
            if (!dropdownRoot) throw new Error('Không tìm thấy khu vực Tags trên form.');

            const selectedTexts = getSelectedTagTexts(dropdownRoot);
            const hasSource = selectedTexts.includes(TAG_SOURCE);
            const hasTargetAlready = selectedTexts.includes(TAG_TARGET);

            if (!hasSource) {
                // Không có tag nguồn -> không đổi tag, nhưng VẪN lưu Equivalent Amount ở giai đoạn 3.
                setStage('tag', 'skipped', `Không có tag "${TAG_SOURCE}" nên chỉ lưu Equivalent Amount, không đổi tag.`);
            } else {
                // Mở dropdown Tags để thao tác trên checkbox bên trong.
                const control = dropdownRoot.querySelector('.control');
                utils.simulateClick(control);
                await utils.waitForElement([`${dropdownRootSelector} .content .selected`], 10000);
                await utils.sleep(250);

                // Bỏ chọn tag nguồn ("Waiting for bank statement").
                const removed = setTagChecked(dropdownRoot, TAG_SOURCE, false);
                if (!removed) throw new Error(`Không tìm thấy tag "${TAG_SOURCE}" để bỏ chọn (dropdown).`);
                await utils.sleep(300);

                // Chọn tag đích ("Waiting for bank statement ► Checked"), chỉ khi chưa có sẵn.
                if (!hasTargetAlready) {
                    const checked = setTagChecked(dropdownRoot, TAG_TARGET, true);
                    if (!checked) throw new Error(`Không tìm thấy tag "${TAG_TARGET}" để chọn.`);
                    await utils.sleep(300);
                }

                // Đóng dropdown (bấm lại vào .control để toggle đóng).
                utils.simulateClick(control);
                await utils.sleep(300);

                setStage('tag', 'success', hasTargetAlready
                    ? `Đã bỏ tag "${TAG_SOURCE}" (tag "${TAG_TARGET}" đã có sẵn).`
                    : `Đã đổi tag "${TAG_SOURCE}" → "${TAG_TARGET}".`);
            }
        } catch (err) {
            setStage('tag', 'error', (err && err.message) || String(err));
            tagError = true;
        }
        persist();

        if (tagError) {
            setStage('save', 'skipped', 'Bỏ qua vì giai đoạn 2 (Tags) bị lỗi.');
            entry.status = 'error';
            persist();
            advanceJob(job);
            return;
        }

        if (isStopNow()) { bailStopNow(); return; }

        // ================= GIAI ĐOẠN 3: Bấm Save + xử lý hộp thoại xác nhận ================= //
        try {
            const saveBtn = findSaveButton();
            if (!saveBtn) throw new Error('Không tìm thấy nút Save.');
            utils.simulateClick(saveBtn);

            // Mỗi lần Save đều hiện hộp thoại xác nhận "Update Confirm" -> chờ nó xuất hiện.
            await utils.waitForElement(['app-sts-confirm-modal'], 15000);

            // Nghỉ ~500ms trước khi bấm nút xác nhận, đảm bảo Angular đã bind xong (click) handler
            // cho nút "Yes" (tránh bấm quá sớm ngay khi modal vừa hiện ra).
            await utils.sleep(500);

            const yesBtn = findConfirmModalButton('app-sts-confirm-modal', 'Yes');
            if (!yesBtn) throw new Error('Không tìm thấy nút "Yes" trong hộp thoại xác nhận.');
            utils.simulateClick(yesBtn);

            // Chờ hộp thoại xác nhận biến mất. Không coi timeout ở đây là lỗi fatal (không throw) vì
            // trên thực tế đã ghi nhận trường hợp modal không được phát hiện là "đã đóng" dù server
            // đã xử lý Save thành công - tín hiệu đáng tin cậy hơn là toast Success/Error bên dưới.
            let confirmModalNote = '';
            await utils.waitForElementToDisappear(['app-sts-confirm-modal'], 15000).catch(() => {
                confirmModalNote = ' (Lưu ý: hộp thoại xác nhận không phát hiện đã đóng, nhưng vẫn tiếp tục theo dõi kết quả lưu.)';
            });

            // Chờ overlay loading (nếu có) biến mất - không fatal nếu không phát hiện được.
            await utils.waitForLoadingToComplete('.box-loading', 30000).catch(() => {});

            // Đọc kết quả từ toast Success/Error do hệ thống hiển thị sau khi lưu.
            let saveStatus = 'success';
            let saveMessage = 'Đã lưu thành công.';
            try {
                const respEl = await utils.waitForServerResponse(15000);
                const isError = respEl.classList.contains('toast-error');
                const text = normalizeText(respEl.querySelector('.toast-message')?.textContent)
                    || normalizeText(respEl.querySelector('.toast-title')?.textContent);
                saveMessage = text || saveMessage;
                if (isError) saveStatus = 'error';
                await utils.sleep(500);
            } catch (e) {
                saveMessage = 'Đã bấm Save nhưng không phát hiện thông báo phản hồi (giả định thành công).';
            }

            setStage('save', saveStatus, saveMessage + confirmModalNote);
            entry.status = saveStatus === 'error' ? 'error' : 'success';
        } catch (err) {
            setStage('save', 'error', (err && err.message) || String(err));
            entry.status = 'error';
        }
        persist();

        advanceJob(job);
    }

    /* =========================================================================
     *  Dispatcher: xử lý item hiện tại theo đúng định dạng của nó
     * ========================================================================= */

    /**
     * Hàm điều phối: chạy trên trang edit của item mà job đang trỏ tới. Đánh dấu item
     * 'processing', rồi gọi đúng processor theo entry.format. Nếu không có processor cho định
     * dạng đó -> ghi lỗi toàn bộ giai đoạn rồi chuyển sang item kế.
     */
    async function processCurrentItem() {
        const job = loadJob();
        if (!job || isJobFinished(job)) return;

        const id = job.ids[job.index];
        const entry = job.log.find((e) => e.id === id);
        if (!entry) {
            advanceJob(job);
            return;
        }

        entry.status = 'processing';
        saveJob(job);
        renderModal();

        const processor = FORMAT_PROCESSORS[entry.format];
        if (typeof processor !== 'function') {
            stageKeysOf(entry.format).forEach((key) => {
                entry.stages[key] = { status: 'error', message: `Không có quy trình xử lý cho định dạng "${entry.format}".` };
            });
            entry.status = 'error';
            saveJob(job);
            renderModal();
            advanceJob(job);
            return;
        }

        await processor(entry, job);
    }

    /**
     * Tăng index của job lên 1 (đánh dấu item hiện tại đã xử lý xong) rồi:
     * - Nếu đã hết danh sách hoặc job bị dừng -> render modal ở chế độ tổng kết, không điều hướng.
     * - Nếu còn item tiếp theo -> điều hướng (reload trang thật) sang URL edit của item đó sau
     *   một khoảng nghỉ ngắn, để job tiếp tục được xử lý bởi init() ở lần load trang kế tiếp.
     */
    function advanceJob(job) {
        job.index += 1;
        // saveJob() sẽ ép job.stopped = true nếu người dùng vừa bấm "Dừng lại" -> isJobFinished
        // bên dưới bắt được và không điều hướng sang item kế.
        saveJob(job);
        if (isJobFinished(job)) {
            renderModal();
            return;
        }
        const nextId = job.ids[job.index];
        setTimeout(() => {
            // Chốt lần cuối ngay trước khi điều hướng: user có thể bấm "Dừng lại" trong 700ms này.
            const latest = loadJob();
            if (!latest || latest.stopped || latest.index >= latest.ids.length) {
                renderModal();
                return;
            }
            location.href = getExpectedUrl(nextId);
        }, 700);
    }

    /* =========================================================================
     *  UI: nút nổi + modal
     * ========================================================================= */

    /** Chèn CSS dùng cho modal vào <head>, chỉ chèn 1 lần (idempotent). Nút nổi do Floating
     *  Button Manager trong thư viện dùng chung tự quản lý style, không cần CSS riêng ở đây. */
    function injectStyles() {
        if (document.getElementById('fpcb-style')) return;
        const style = document.createElement('style');
        style.id = 'fpcb-style';
        style.textContent = `
            .fpcb-modal {
                position: fixed;
                top: 12vh;
                left: 50%;
                transform: translateX(-50%);
                background: #fff;
                border-radius: 8px;
                width: 920px;
                max-width: 94vw;
                max-height: 80vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                font-family: Arial, sans-serif;
                box-shadow: 0 8px 30px rgba(0,0,0,.35);
                z-index: 999999;
            }
            .fpcb-modal--dragging { user-select: none; }
            .fpcb-modal__header {
                padding: 14px 18px;
                border-bottom: 1px solid #ebedf2;
                display: flex; align-items: center; justify-content: space-between;
                cursor: move;
            }
            .fpcb-modal__header h3 { margin: 0; font-size: 16px; }
            .fpcb-modal__close { cursor: pointer; border: none; background: none; font-size: 18px; color: #888; }
            .fpcb-modal__body { padding: 18px; overflow-y: auto; flex: 1; }
            .fpcb-modal__footer {
                padding: 12px 18px; border-top: 1px solid #ebedf2;
                display: flex; justify-content: flex-end; gap: 8px;
            }
            /* Ô nhập liệu có máng số dòng bên trái. .fpcb-gutter và .fpcb-textarea phải cùng
               font / line-height (13px/1.5) và cùng padding-top (8px) để số dòng luôn thẳng hàng.
               .fpcb-editor bị CHỐT chiều cao nên input dài không làm hộp thoại phình to — chỉ
               textarea cuộn nội bộ, còn máng số được kéo theo qua gutter.scrollTop (xem syncGutter). */
            .fpcb-editor {
                display: flex; margin-top: 4px;
                border: 1px solid #ccc; border-radius: 4px;
                overflow: hidden;      /* clip phần tràn + cần cho resize */
                height: 220px;         /* chiều cao cố định, không đổi theo độ dài input */
                min-height: 120px;
                resize: vertical;      /* user vẫn kéo to/nhỏ được (chuyển từ .fpcb-textarea lên) */
            }
            .fpcb-gutter {
                flex: 0 0 auto; min-width: 34px; box-sizing: border-box;
                padding: 8px 6px 8px 0; text-align: right;
                font: 13px/1.5 Consolas, "Courier New", monospace;
                color: #999; background: #f5f5f5; border-right: 1px solid #e3e3e3;
                white-space: pre; overflow: hidden; user-select: none;
            }
            .fpcb-textarea {
                flex: 1 1 auto; height: 100%; box-sizing: border-box;
                border: 0; border-radius: 0; padding: 8px; margin: 0;
                font: 13px/1.5 Consolas, "Courier New", monospace;
                white-space: pre; overflow: auto;   /* cuộn dọc + ngang trong chính textarea */
            }
            .fpcb-textarea:focus { outline: none; }
            .fpcb-hint { font-size: 12px; color: #888; margin-top: 6px; }
            .fpcb-btn {
                border: none; border-radius: 4px; padding: 8px 16px;
                font-size: 13px; font-weight: 600; cursor: pointer;
            }
            .fpcb-btn--primary { background: #636ae8; color: #fff; }
            .fpcb-btn--primary:hover { background: #4f56d4; }
            .fpcb-btn--default { background: #ebedf2; color: #333; }
            .fpcb-btn--danger { background: #e43f3f; color: #fff; }
            .fpcb-preview { font-size: 12px; color: #333; margin-top: 8px; max-height: 120px; overflow-y: auto; }
            .fpcb-preview__warn { color: #b98900; margin-top: 6px; white-space: pre-wrap; }
            .fpcb-preview__error { color: #e43f3f; margin-top: 6px; white-space: pre-wrap; font-weight: 600; }
            .fpcb-stage-msg { font-size: 11px; color: #666; margin-top: 4px; line-height: 1.4; }
            /* Vùng cuộn RIÊNG cho bảng log: trần chiều cao CỐ ĐỊNH để hộp thoại không phình theo số item. */
            .fpcb-log {
                margin-top: 4px; max-height: 340px; overflow: auto;
                overscroll-behavior: contain;
                border: 1px solid #ebedf2; border-radius: 4px;
            }
            .fpcb-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .fpcb-table th, .fpcb-table td { border-bottom: 1px solid #ebedf2; padding: 6px 8px; text-align: left; vertical-align: top; }
            /* Giữ hàng tiêu đề cột dính khi cuộn danh sách item dài. */
            .fpcb-table thead th {
                position: sticky; top: 0; z-index: 1;
                background: #fff; box-shadow: inset 0 -1px 0 #ebedf2;
            }
            .fpcb-status { display: inline-block; padding: 2px 8px; border-radius: 100px; font-size: 12px; white-space: nowrap; }
            .fpcb-status--pending { background: rgba(119,119,119,.15); color: #777; }
            .fpcb-status--processing { background: rgba(42,130,254,.15); color: #2a82fe; }
            .fpcb-status--success { background: rgba(51,153,51,.15); color: #393; }
            .fpcb-status--skipped { background: rgba(255,193,7,.2); color: #b98900; }
            .fpcb-status--error { background: rgba(228,63,63,.2); color: #e43f3f; }
            .fpcb-summary { font-size: 13px; margin-bottom: 10px; color: #333; }
        `;
        document.head.appendChild(style);
    }

    /**
     * Xử lý khi user bấm nút nổi: nếu đang có job (dù chạy dở hay đã xong) thì mở modal ở chế độ
     * xem tiến trình; nếu chưa có job nào thì mở modal ở chế độ nhập danh sách mới.
     */
    function onFabClick() {
        const job = loadJob();
        modalMode = job ? 'progress' : 'input';
        renderModal();
    }

    // Tham chiếu tới element modal đang hiển thị trên trang (null nếu modal đang đóng).
    let modalRoot = null;
    // Chế độ hiển thị hiện tại của modal: 'input' (nhập danh sách) hoặc 'progress' (xem tiến trình).
    let modalMode = 'input';
    // true = tự cuộn bảng log xuống cuối mỗi lần render. Reset về true mỗi lần trang load (module
    // nạp lại) nên sau mỗi lần reload giữa các item, người dùng luôn thấy item mới nhất. Tắt tạm
    // khi user chủ động cuộn lên đọc log cũ, bật lại khi họ cuộn về sát đáy.
    let progressStickToBottom = true;
    // Vị trí modal đã lưu (nếu user từng kéo), đọc 1 lần khi script khởi động.
    let modalPosition = loadModalPosition();

    /** Đọc vị trí modal đã lưu (nếu có) từ localStorage. */
    function loadModalPosition() {
        try {
            const raw = localStorage.getItem(MODAL_POSITION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    /** Lưu vị trí modal (left/top tính theo px so với viewport) vào localStorage. */
    function saveModalPosition(pos) {
        modalPosition = pos;
        try {
            localStorage.setItem(MODAL_POSITION_KEY, JSON.stringify(pos));
        } catch (e) {
            // Bỏ qua nếu không lưu được (ví dụ localStorage đầy) - không ảnh hưởng chức năng chính.
        }
    }

    /* ---- Kéo (drag) hộp thoại bằng vùng header ---- */
    const dragState = { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 };

    /** Bắt đầu kéo modal khi mousedown trên header (trừ khi bấm đúng vào nút đóng). */
    function onHeaderMouseDown(e) {
        if (e.target.closest('.fpcb-modal__close')) return;
        if (!modalRoot) return;
        const rect = modalRoot.getBoundingClientRect();
        dragState.active = true;
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.startLeft = rect.left;
        dragState.startTop = rect.top;
        // Chuyển từ định vị bằng transform (căn giữa mặc định) sang left/top tuyệt đối.
        modalRoot.style.left = rect.left + 'px';
        modalRoot.style.top = rect.top + 'px';
        modalRoot.style.transform = 'none';
        modalRoot.classList.add('fpcb-modal--dragging');
        e.preventDefault();
    }

    /** Cập nhật vị trí modal theo vị trí chuột trong lúc đang kéo, giới hạn trong viewport. */
    function onDocumentMouseMove(e) {
        if (!dragState.active || !modalRoot) return;
        const rect = modalRoot.getBoundingClientRect();
        const maxLeft = Math.max(window.innerWidth - rect.width, 0);
        const maxTop = Math.max(window.innerHeight - rect.height, 0);
        let newLeft = dragState.startLeft + (e.clientX - dragState.startX);
        let newTop = dragState.startTop + (e.clientY - dragState.startY);
        newLeft = Math.min(Math.max(newLeft, 0), maxLeft);
        newTop = Math.min(Math.max(newTop, 0), maxTop);
        modalRoot.style.left = newLeft + 'px';
        modalRoot.style.top = newTop + 'px';
    }

    /** Kết thúc kéo modal (mouseup) và lưu lại vị trí cuối cùng. */
    function onDocumentMouseUp() {
        if (!dragState.active) return;
        dragState.active = false;
        if (modalRoot) {
            modalRoot.classList.remove('fpcb-modal--dragging');
            const rect = modalRoot.getBoundingClientRect();
            saveModalPosition({ left: rect.left, top: rect.top });
        }
    }

    document.addEventListener('mousemove', onDocumentMouseMove);
    document.addEventListener('mouseup', onDocumentMouseUp);

    /** Đóng (gỡ khỏi DOM) modal đang hiển thị, nếu có. */
    function closeModal() {
        if (modalRoot) {
            modalRoot.remove();
            modalRoot = null;
        }
    }

    /**
     * Vẽ lại modal từ đầu dựa theo `modalMode` và trạng thái job hiện tại trong localStorage.
     * Modal là hộp nổi độc lập (KHÔNG có lớp phủ mờ che toàn trang) để không cản trở việc quan
     * sát/thao tác trên trang bên dưới trong lúc script đang tự động chạy.
     */
    function renderModal() {
        closeModal();

        const job = loadJob();
        const modal = document.createElement('div');
        modal.className = 'fpcb-modal';
        if (modalPosition) {
            modal.style.left = modalPosition.left + 'px';
            modal.style.top = modalPosition.top + 'px';
            modal.style.transform = 'none';
        }

        // ---- Header: tiêu đề + nút đóng, đồng thời là vùng để kéo modal ----
        const header = document.createElement('div');
        header.className = 'fpcb-modal__header';
        header.addEventListener('mousedown', onHeaderMouseDown);
        const title = document.createElement('h3');
        title.textContent = 'Consolidate Payment Item with Bank Statement';
        header.appendChild(title);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'fpcb-modal__close';
        closeBtn.type = 'button';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', () => {
            const currentJob = loadJob();
            if (currentJob && !isJobFinished(currentJob)) {
                if (!confirm('Đang xử lý dở danh sách. Dừng lại và đóng?')) return;
                currentJob.stopped = true;
                saveJob(currentJob);
            }
            closeModal();
        });
        header.appendChild(closeBtn);
        modal.appendChild(header);

        const body = document.createElement('div');
        body.className = 'fpcb-modal__body';
        modal.appendChild(body);

        const footer = document.createElement('div');
        footer.className = 'fpcb-modal__footer';
        modal.appendChild(footer);

        if (modalMode === 'input' || !job) {
            renderInputView(body, footer);
        } else {
            renderProgressView(body, footer, job);
        }

        document.body.appendChild(modal);
        modalRoot = modal;

        // Modal đã vào DOM (có layout thật) -> cuộn bảng log xuống item mới nhất để người dùng
        // theo dõi được tiến trình sau mỗi lần trang tự reload. Bỏ qua nếu user đang cuộn lên đọc.
        const logEl = modal.querySelector('.fpcb-log');
        if (logEl && progressStickToBottom) {
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    /**
     * Vẽ view nhập liệu: textarea free-text để paste danh sách, preview realtime số task nhận
     * diện được + cảnh báo các dòng không hợp lệ, nút "Bắt đầu" để khởi tạo job mới.
     */
    function renderInputView(body, footer) {
        const label = document.createElement('div');
        label.innerHTML = 'Nhập danh sách, mỗi dòng là một item cần xử lý.';
        body.appendChild(label);

        const formatsHint = document.createElement('div');
        formatsHint.className = 'fpcb-hint';
        formatsHint.innerHTML = 'Định dạng dòng đang hỗ trợ:<br>'
            + LINE_FORMATS.map((f) => `&bull; <b>${f.label}</b>`).join('<br>');
        body.appendChild(formatsHint);

        // Ô nhập liệu + máng số dòng bên trái, giúp đối chiếu nhanh với thông báo lỗi ("dòng x").
        const editor = document.createElement('div');
        editor.className = 'fpcb-editor';

        const gutter = document.createElement('div');
        gutter.className = 'fpcb-gutter';
        editor.appendChild(gutter);

        const textarea = document.createElement('textarea');
        textarea.className = 'fpcb-textarea';
        textarea.setAttribute('wrap', 'off'); // mỗi dòng logic = 1 dòng hiển thị -> số dòng khớp 1-1
        textarea.placeholder = '#123456   1,234,567.00\n#234567\t2000000';
        editor.appendChild(textarea);

        body.appendChild(editor);

        // Dựng lại danh sách số dòng theo nội dung hiện tại + giữ máng cuộn dọc trùng textarea.
        const syncGutter = () => {
            const n = Math.max(1, textarea.value.split('\n').length);
            let s = '';
            for (let i = 1; i <= n; i++) s += i + '\n';
            gutter.textContent = s;
            gutter.scrollTop = textarea.scrollTop;
        };
        textarea.addEventListener('input', syncGutter);
        textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; });
        syncGutter();

        const hint = document.createElement('div');
        hint.className = 'fpcb-hint';
        hint.textContent = 'Các giá trị trên một dòng cách nhau bởi một hoặc nhiều khoảng trắng / tab. Equivalent Amount chỉ gồm chữ số, dấu phẩy, dấu chấm.';
        body.appendChild(hint);

        const preview = document.createElement('div');
        preview.className = 'fpcb-preview';
        body.appendChild(preview);

        const updatePreview = () => {
            const { tasks, invalidLines, duplicateIds } = parseInput(textarea.value);
            const parts = [];
            if (tasks.length) {
                parts.push(`Đã nhận diện ${tasks.length} item:`);
                parts.push(tasks.map((t) => `#${t.id} → ${t.equivalentAmount}`).join(', '));
            }
            preview.textContent = parts.join(' ');

            // Lỗi chặn: cùng một payment item id xuất hiện ở nhiều dòng.
            if (duplicateIds.length) {
                const errBox = document.createElement('div');
                errBox.className = 'fpcb-preview__error';
                errBox.textContent = `Không cho phép chạy — có payment item bị nhập trùng:\n`
                    + duplicateIds.map((d) => `  #${d.id}: các dòng ${d.lineNos.join(', ')}`).join('\n');
                preview.appendChild(errBox);
            }

            // Cảnh báo (không chặn): các dòng không đúng định dạng nào.
            if (invalidLines.length) {
                const warn = document.createElement('div');
                warn.className = 'fpcb-preview__warn';
                warn.textContent = `${invalidLines.length} dòng không nhận diện được (sẽ bị bỏ qua):\n`
                    + invalidLines.map((l) => `  dòng ${l.lineNo}: ${l.text}`).join('\n');
                preview.appendChild(warn);
            }
        };
        textarea.addEventListener('input', updatePreview);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'fpcb-btn fpcb-btn--default';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Đóng';
        cancelBtn.addEventListener('click', closeModal);
        footer.appendChild(cancelBtn);

        const startBtn = document.createElement('button');
        startBtn.className = 'fpcb-btn fpcb-btn--primary';
        startBtn.type = 'button';
        startBtn.textContent = 'Bắt đầu';
        startBtn.addEventListener('click', () => {
            const result = parseInput(textarea.value);

            // Lỗi chặn (ưu tiên báo trước): payment item id bị nhập trùng ở nhiều dòng.
            if (result.duplicateIds.length) {
                alert('Không thể chạy quy trình — các payment item sau bị nhập trùng, mỗi item chỉ được xuất hiện một lần:\n\n'
                    + result.duplicateIds.map((d) => `#${d.id}: các dòng ${d.lineNos.join(', ')}`).join('\n')
                    + '\n\nVui lòng xoá bớt các dòng trùng rồi thử lại.');
                return;
            }
            if (!result.tasks.length) {
                alert('Không nhận diện được item nào hợp lệ. Vui lòng kiểm tra lại định dạng.');
                return;
            }
            if (result.invalidLines.length
                && !confirm(`Có ${result.invalidLines.length} dòng không hợp lệ sẽ bị bỏ qua. Tiếp tục với ${result.tasks.length} item hợp lệ?`)) {
                return;
            }
            startJob(result.tasks);
        });
        footer.appendChild(startBtn);
    }

    /**
     * Vẽ view tiến trình: dòng tóm tắt, bảng chi tiết trạng thái từng item (số cột tuỳ theo
     * FORMAT_STAGES của định dạng các item), và các nút hành động theo trạng thái job.
     */
    function renderProgressView(body, footer, job) {
        const finished = isJobFinished(job);
        const doneCount = job.log.filter((e) => e.status !== 'pending' && e.status !== 'processing').length;

        const summary = document.createElement('div');
        summary.className = 'fpcb-summary';
        if (finished) {
            const successCount = job.log.filter((e) => e.status === 'success').length;
            const errorCount = job.log.filter((e) => e.status === 'error').length;
            summary.textContent = (job.stopped ? 'Đã dừng theo yêu cầu. ' : '')
                + `Hoàn tất ${doneCount}/${job.ids.length} item — Thành công: ${successCount}, Lỗi: ${errorCount}.`;
        } else {
            summary.textContent = `Đang xử lý ${doneCount}/${job.ids.length} item... (Trang sẽ tự tải lại giữa các item, vui lòng không đóng tab)`;
        }
        body.appendChild(summary);

        // Cột giai đoạn: lấy theo định dạng của item đầu tiên (hiện mọi item cùng một định dạng).
        const format = (job.log[0] && job.log[0].format) || LINE_FORMATS[0].id;
        const stages = FORMAT_STAGES[format] || [];

        const table = document.createElement('table');
        table.className = 'fpcb-table';
        table.innerHTML = '<thead><tr><th>Payment Item ID</th>'
            + stages.map((s) => `<th>${s.label}</th>`).join('')
            + '</tr></thead>';
        const tbody = document.createElement('tbody');

        const renderStageCell = (td, stage) => {
            const s = stage || { status: 'pending', message: '' };
            const badge = document.createElement('span');
            badge.className = `fpcb-status fpcb-status--${s.status}`;
            badge.textContent = statusLabel(s.status);
            td.appendChild(badge);
            if (s.message) {
                const msg = document.createElement('div');
                msg.className = 'fpcb-stage-msg';
                msg.textContent = s.message;
                td.appendChild(msg);
            }
        };

        job.log.forEach((entry) => {
            const tr = document.createElement('tr');
            const tdId = document.createElement('td');
            tdId.innerHTML = `<a href="${getExpectedUrl(entry.id)}" target="_blank">#${entry.id}</a>`;
            tr.appendChild(tdId);

            (FORMAT_STAGES[entry.format] || stages).forEach((s) => {
                const td = document.createElement('td');
                renderStageCell(td, entry.stages && entry.stages[s.key]);
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        // Bọc bảng trong vùng cuộn riêng: dòng .fpcb-summary phía trên và footer luôn cố định,
        // chỉ danh sách item cuộn bên trong .fpcb-log.
        const logWrap = document.createElement('div');
        logWrap.className = 'fpcb-log';
        logWrap.appendChild(table);
        // Người dùng cuộn lên đọc log cũ -> tạm ngừng bám đáy; cuộn lại sát đáy -> bật lại.
        logWrap.addEventListener('scroll', () => {
            progressStickToBottom =
                logWrap.scrollHeight - logWrap.scrollTop - logWrap.clientHeight <= 8;
        });
        body.appendChild(logWrap);

        if (!finished) {
            const stopBtn = document.createElement('button');
            stopBtn.className = 'fpcb-btn fpcb-btn--danger';
            stopBtn.type = 'button';
            stopBtn.textContent = 'Dừng lại';
            stopBtn.addEventListener('click', () => {
                // Chỉ hỏi 1 lần - chọn chế độ dừng. CẢ HAI lựa chọn đều dừng job.
                const stopNow = !confirm(
                    'Hoàn tất item ĐANG xử lý rồi mới dừng?\n\n'
                    + 'OK = chạy nốt item hiện tại rồi dừng (khuyến nghị).\n'
                    + 'Cancel = DỪNG NGAY, item hiện tại có thể còn dở dang.'
                );
                const currentJob = loadJob();
                if (!currentJob) return;
                currentJob.stopped = true;
                currentJob.stopMode = stopNow ? 'now' : 'after-current';
                saveJob(currentJob);
                renderModal();
            });
            footer.appendChild(stopBtn);

            const hideBtn = document.createElement('button');
            hideBtn.className = 'fpcb-btn fpcb-btn--default';
            hideBtn.type = 'button';
            hideBtn.textContent = 'Ẩn cửa sổ (vẫn tiếp tục chạy)';
            hideBtn.addEventListener('click', closeModal);
            footer.appendChild(hideBtn);
        } else {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'fpcb-btn fpcb-btn--default';
            closeBtn.type = 'button';
            closeBtn.textContent = 'Đóng';
            closeBtn.addEventListener('click', () => {
                clearJob();
                closeModal();
            });
            footer.appendChild(closeBtn);

            const newBtn = document.createElement('button');
            newBtn.className = 'fpcb-btn fpcb-btn--primary';
            newBtn.type = 'button';
            newBtn.textContent = 'Chạy danh sách mới';
            newBtn.addEventListener('click', () => {
                clearJob();
                modalMode = 'input';
                renderModal();
            });
            footer.appendChild(newBtn);
        }
    }

    /** Ánh xạ status nội bộ sang nhãn hiển thị trên badge trong bảng tiến trình. */
    function statusLabel(status) {
        switch (status) {
            case 'pending': return 'Chờ xử lý';
            case 'processing': return 'Đang xử lý';
            case 'success': return 'Success';
            case 'skipped': return 'Skip';
            case 'error': return 'Lỗi';
            default: return status;
        }
    }

    /**
     * Khởi tạo 1 job mới từ danh sách task đã parse: lưu job vào localStorage, chuyển modal sang
     * chế độ tiến trình, rồi bắt đầu xử lý item đầu tiên - hoặc điều hướng sang trang edit của
     * item đầu tiên nếu trang hiện tại chưa đúng.
     */
    function startJob(tasks) {
        // Xoá job cũ (nếu còn) trước khi dựng job mới, để merge cờ `stopped` trong saveJob()
        // không vô tình khiến job mới bị đánh dấu đã dừng ngay từ đầu.
        clearJob();

        const ids = tasks.map((t) => t.id);
        const tasksById = {};
        tasks.forEach((t) => { tasksById[t.id] = t; });

        const job = {
            ids,
            tasks: tasksById,
            index: 0,
            stopped: false,
            stopMode: null,   // null | 'now' | 'after-current' - đặt khi user bấm "Dừng lại"
            createdAt: Date.now(),
            log: tasks.map((t) => {
                const stages = {};
                stageKeysOf(t.format).forEach((key) => {
                    stages[key] = { status: 'pending', message: '' };
                });
                return { id: t.id, format: t.format, status: 'pending', stages };
            }),
        };
        saveJob(job);
        modalMode = 'progress';
        renderModal();

        const firstId = ids[0];
        if (getCurrentItemIdFromUrl() === firstId) {
            processCurrentItem();
        } else {
            location.href = getExpectedUrl(firstId);
        }
    }

    /* =========================================================================
     *  Khởi tạo
     * ========================================================================= */

    /**
     * Điểm vào của script, chạy mỗi khi trang được tải (kể cả các lần tự reload giữa các item).
     * Chèn CSS trước, chờ FinplanUtils sẵn sàng để đăng ký nút nổi qua Floating Button Manager
     * dùng chung, rồi kiểm tra job dang dở trong localStorage để tự mở lại modal và tiếp tục:
     *   - Không có job -> chờ user bấm nút nổi.
     *   - Có job nhưng đã kết thúc -> chỉ hiển thị modal tổng kết.
     *   - Có job đang chạy dở -> nếu đúng trang item đang mong đợi thì processCurrentItem(),
     *     ngược lại tự điều hướng lại tới đúng URL.
     */
    async function init() {
        injectStyles();

        try {
            utils = await waitForFinplanUtils();
        } catch (e) {
            console.error('[Consolidate Payment Item with Bank Statement]', e.message);
            return;
        }

        utils.registerButton(BUTTON_ID, {
            icon: '🏦',
            text: 'Consolidate PI w/ Bank Statement',
            tooltip: 'Consolidate Payment Item with Bank Statement',
            onClick: onFabClick,
        });

        const job = loadJob();
        if (!job) return;

        if (isJobFinished(job)) {
            modalMode = 'progress';
            renderModal();
            return;
        }

        const expectedId = job.ids[job.index];
        const currentId = getCurrentItemIdFromUrl();

        modalMode = 'progress';
        renderModal();

        if (currentId === expectedId) {
            processCurrentItem();
        } else {
            location.href = getExpectedUrl(expectedId);
        }
    }

    init();
})();
