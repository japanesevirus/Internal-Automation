// ==UserScript==
// @name         Finplan Shared Library Script
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Duyệt tự động toàn bộ Item, hỗ trợ SPA và chống treo trang
// @author       Gemini AI
// @match        https://finplan.saigontechnology.vn/*
// @match        https://pop.saigontechnology.vn/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

unsafeWindow.FinplanUtils = {
 /**
 * Kiểm tra xem một phần tử có đang hiển thị trên trang hay không.
 * Đáng tin cậy hơn offsetParent vì kiểm tra cả computed style lẫn kích thước thực tế.
 *
 * @param {Element} el - Phần tử cần kiểm tra.
 * @returns {boolean}
 */
    isVisible: function (el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }
        // Kiểm tra kích thước thực tế trên màn hình
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    },

/**
 * Chờ cho đến khi một phần tử khớp selector (và điều kiện filter tùy chọn)
 * xuất hiện và đang hiển thị trên trang.
 *
 * @param {string[]} selectors - Danh sách CSS selector, kiểm tra theo thứ tự.
 * @param {number} [timeout=10000] - Thời gian chờ tối đa (ms).
 * @param {(el: Element) => boolean} [filter=null] - Điều kiện tùy chỉnh bổ sung.
 *        Nếu có, phần tử chỉ được coi là "tìm thấy" khi filter(el) === true.
 * @returns {Promise<Element>}
 */
    waitForElement: function (selectors, timeout = 10000, filter = null) {
        return new Promise((resolve, reject) => {
            const check = () => {
                const selectorList = Array.isArray(selectors) ? selectors : [selectors];
                for (let selector of selectorList) {
                    const elements = document.querySelectorAll(selector);
                    for (let el of elements) {
                        if (!this.isVisible(el)) continue; // Bỏ qua nếu phần tử không hiển thị
                        if (filter && !filter(el)) continue; // Bỏ qua nếu không thỏa filter
                        return el;
                    }
                }
                return null;
            };
            // 1. Kiểm tra ngay lập tức
            const el = check();
            if (el) return resolve(el);
            // 2. Theo dõi cả việc thêm/xóa node lẫn thay đổi class/style/attribute
            const observer = new MutationObserver(() => {
                const el = check();
                if (el) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(el);
                }
            });
            observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true,
                attributes: true, // Theo dõi thay đổi class, style,...
                attributeFilter: ['style', 'class', 'hidden'] // Tối ưu hiệu năng
            });
            // 3. Xử lý Timeout
            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Timeout ${timeout}ms: Không tìm thấy phần tử phù hợp`));
            }, timeout);
        });
    },
/**
 * Chờ cho đến khi có toast kết quả (Success/Error) từ server.
 *
 * Toast do ngx-toastr render, đúng theo cấu trúc DOM thực tế (xem file mẫu
 * "HTML Samples/Error Toast.html" và "HTML Samples/Success Toast.html"):
 *   <div id="toast-container">
 *     <div toast-component class="toast-error ngx-toastr ..."> (hoặc toast-success)
 *       <div class="toast-title" aria-label="Error">Error</div> (hoặc "Success")
 *       <div class="toast-message" aria-label="...">Nội dung thông báo thật</div>
 *     </div>
 *   </div>
 *
 * Trả về chính element toast-component (div.toast-error / div.toast-success) để
 * caller tự xác định loại và lấy nội dung thông báo thật:
 *   - Loại:    el.classList.contains('toast-error')  // true = Error, false = Success
 *   - Message: el.querySelector('.toast-message')?.textContent
 *
 * @param {number} [timeout=10000] - Thời gian chờ tối đa (ms).
 * @param {(el: Element) => boolean} [filter=null] - Điều kiện tùy chọn bổ sung, ví dụ để
 *        loại trừ các toast đã đọc trước đó (tránh đọc trúng toast cũ còn sót trên DOM).
 * @returns {Promise<Element>}
 */
    waitForServerResponse: function (timeout = 10000, filter = null) {
        return this.waitForElement(
            ['#toast-container div.toast-error, #toast-container div.toast-success'],
            timeout,
            filter
        );
    },
 /**
 * Chờ cho đến khi TẤT CẢ phần tử khớp selector (và filter tùy chọn)
 * biến mất khỏi DOM hoặc không còn hiển thị nữa.
 *
 * @param {string[]} selectors - Danh sách CSS selector, kiểm tra theo thứ tự.
 * @param {number} [timeout=10000] - Thời gian chờ tối đa (ms).
 * @param {(el: Element) => boolean} [filter=null] - Điều kiện tùy chỉnh bổ sung.
 *        Nếu có, chỉ những phần tử thỏa filter(el) === true mới được tính là "phải biến mất".
 * @returns {Promise<void>}
 */
    waitForElementToDisappear: function (selectors, timeout = 10000, filter = null) {
        return new Promise((resolve, reject) => {
            // Trả về true nếu KHÔNG còn phần tử nào khớp điều kiện đang hiển thị
            const isGone = () => {
                const selectorList = Array.isArray(selectors) ? selectors : [selectors];
                for (let selector of selectorList) {
                    const elements = document.querySelectorAll(selector);
                    for (let el of elements) {
                        if (!this.isVisible(el)) continue; // đã ẩn, bỏ qua
                        if (filter && !filter(el)) continue; // không thỏa filter, bỏ qua
                        return false; // còn ít nhất 1 phần tử thỏa điều kiện và đang hiển thị
                    }
                }
                return true; // không còn phần tử nào thỏa điều kiện và hiển thị
            };

            if (isGone()) return resolve();

            const observer = new MutationObserver(() => {
                if (isGone()) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve();
                }
            });

            observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true,
                attributes: true, // bắt các thay đổi kiểu display:none, class, hidden...
                attributeFilter: ['style', 'class', 'hidden']
            });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error('Timeout: phần tử vẫn còn hiển thị sau ' + timeout + 'ms'));
            }, timeout);
        });
    },
/**
 * Chờ cho đến khi TẤT CẢ các phần tử được truyền vào (theo reference, không phải selector)
 * biến mất khỏi DOM hoặc không còn hiển thị nữa.
 *
 * Khác với waitForElementToDisappear (dùng selector để tìm kiếm lại mỗi lần check),
 * hàm này theo dõi trực tiếp các phần tử đã có sẵn reference — phù hợp khi bạn đã
 * giữ tham chiếu đến phần tử từ trước (ví dụ: kết quả trả về từ waitForElement).
 *
 * @param {Element|Element[]} elements - Một phần tử hoặc mảng các phần tử cần theo dõi.
 * @param {number} [timeout=10000] - Thời gian chờ tối đa (ms).
 * @returns {Promise<void>}
 */
    waitForElementsRemoved: function (elements, timeout = 10000) {
        return new Promise((resolve, reject) => {
            // Chuẩn hóa đầu vào thành mảng, đồng thời loại bỏ các giá trị null/undefined
            // (phòng trường hợp truyền vào phần tử không tồn tại, ví dụ kết quả
            // querySelector không tìm thấy gì)
            const els = (Array.isArray(elements) ? elements : [elements])
            .filter(el => el != null);

            // Nếu sau khi lọc không còn phần tử nào hợp lệ để theo dõi,
            // coi như điều kiện "đã biến mất" được thỏa mãn ngay lập tức
            if (els.length === 0) return resolve();

            // Phần tử được coi là "biến mất" nếu không còn kết nối với DOM
            // hoặc không còn hiển thị (dùng chung logic với isVisible)
            const isGone = (el) => !el.isConnected || !this.isVisible(el);
            const allGone = () => els.every(isGone);

            if (allGone()) return resolve();

            const observer = new MutationObserver(() => {
                if (allGone()) {
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve();
                }
            });

            observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class', 'hidden']
            });

            const timer = setTimeout(() => {
                observer.disconnect();
                reject(new Error('Timeout: phần tử vẫn còn tồn tại/hiển thị sau ' + timeout + 'ms'));
            }, timeout);
        });
    },
/**
 * Tìm ancestor gần nhất khớp với rowTag/selector (không tính chính el).
 *
 * @param {HTMLElement} el
 * @param {string} [rowTag='TR'] - Có thể là tagName hoặc CSS selector bất kỳ.
 * @returns {HTMLElement|null}
 */
    findAncestorRow: function findAncestorRow(el, selector = 'TR') {
        if (!el) return null;
        return el.parentElement?.closest(selector) ?? null;
    },
/**
 * Đợi loading box xuất hiện và biến mất
 */
    waitForLoadingToComplete: function (selector = '.box-loading', timeout = 30000) {
        return new Promise((resolve, reject) => {
            let loadingEl = null;
            let isAppeared = false;

            const checkState = () => {
                // Trường hợp 1: Chưa xuất hiện -> Kiểm tra xem đã xuất hiện chưa
                if (!isAppeared) {
                    const el = document.querySelector(selector);
                    // Kiểm tra element tồn tại trong DOM)
                    if (el) {
                        isAppeared = true;
                        loadingEl = el;
                    }
                }

                // Trường hợp 2: Đã xuất hiện -> Kiểm tra xem đã biến mất chưa
                if (isAppeared) {

                    if (!document.body.contains(loadingEl)) {
                        cleanup();
                        return resolve(true); // Loading hoàn tất
                    }
                }
            };

            const cleanup = () => {
                observer.disconnect();
                clearTimeout(timer);
            };

            // 1. Kiểm tra trạng thái ban đầu
            checkState();

            // 2. Theo dõi các thay đổi trong DOM (thêm/xóa node và thay đổi style/class)
            const observer = new MutationObserver(() => {
                checkState();
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class', 'hidden']
            });

            // 3. Timeout phòng trường hợp loading bị kẹt quá lâu
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Timeout ${timeout}ms: Loading box không hoàn tất chu trình.`));
            }, timeout);
        });
    },
/**
 * Tìm một element nằm trong cùng dòng (<tr>) với element đã cho.
 *
 * @param {HTMLElement} el - Element ban đầu, dùng để xác định dòng (<tr>) cần tìm.
 * @param {string} selector - CSS selector để tìm element mục tiêu trong dòng đó.
 * @param {(target: HTMLElement) => boolean} [filterFn] - Hàm lọc thêm điều kiện
 *        mà selector không diễn tả được. Có thể truyền null/undefined nếu không cần lọc thêm.
 * @param {string} [rowTag='TR'] - Tag của "dòng" cần dừng lại khi đi ngược DOM lên.
 * @returns {HTMLElement|null} - Element tìm được, hoặc null nếu không tìm thấy.
 */
    findElementInSameRow:function (el, selector, filterFn, rowTag = 'TR') {
        if (!el) return null;

        // 1. Tìm dòng (row) chứa el
        const row = this.findAncestorRow(el, rowTag);
        if (!row) return null; // Không tìm thấy dòng chứa el

        // 2. Tìm tất cả element khớp selector trong dòng đó
        const candidates = row.querySelectorAll(selector);
        if (!candidates.length) return null;

        // 3. Kiểm tra filterFn có phải là hàm hợp lệ không trước khi gọi
        const isValidFilterFn = typeof filterFn === 'function';

        // 4. Duyệt qua các candidate, nếu không có filterFn hợp lệ thì lấy luôn cái đầu tiên
        for (const candidate of candidates) {
            if (!isValidFilterFn || filterFn(candidate)) {
                return candidate;
            }
        }

        return null;
    },
/**
 * Giả lập click chuột
 *
 * @param {HTMLElement} el - Element cần giả lập.
 */
    simulateClick: function (el) {
        if (!el) return;
        const opts = { bubbles: true, cancelable: true, view: unsafeWindow };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.click();
    },
/**
 * Hàm tiện ích nhỏ để "ngủ" một khoảng thời gian
 */
    sleep: function (ms) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }
};

/**
 * ============================================================================
 * FLOATING BUTTON MANAGER
 * ============================================================================
 * Cho phép nhiều Tampermonkey plugin (mỗi plugin phụ trách 1 chức năng)
 * cùng đăng ký một nút nổi (floating button) mà không bị chồng chéo lên nhau.
 *
 * Khu vực hiển thị: góc dưới bên trái màn hình.
 * Mỗi nút hiển thị dạng pill (viên thuốc bo tròn 2 đầu), gồm icon + text,
 * xếp theo cột dọc, canh trái.
 * Thứ tự hiển thị: sắp theo `order` tăng dần (mặc định 0), nếu bằng nhau thì
 * sắp theo `id` tăng dần (a-z) để đảm bảo thứ tự NHẤT QUÁN giữa mọi session,
 * không phụ thuộc thứ tự các script được load.
 * Nút có order/id nhỏ nhất sẽ nằm GẦN ĐÁY màn hình nhất.
 *
 * Khi số nút hiển thị vượt quá MAX_VISIBLE_BUTTONS, các nút có độ ưu tiên
 * thấp hơn (order/id lớn hơn) sẽ được gom vào 1 nút "(n) more..." (More).
 * Bấm vào nút này sẽ bung ra danh sách các nút còn lại.
 *
 * API công khai (được gắn thêm vào unsafeWindow.FinplanUtils):
 *   - registerButton(id, { icon, text, tooltip, onClick, visible, order })
 *   - unregisterButton(id)
 *   - setButtonVisible(id, visible)
 *   - updateButton(id, partialOptions)
 * ============================================================================
 */
(function () {
    // Số nút tối đa hiển thị trực tiếp (bao gồm cả nút "More" nếu có tràn)
    var MAX_VISIBLE_BUTTONS = 3;

    // Map<id, { icon, text, tooltip, onClick, visible, order }>
    var buttonRegistry = new Map();

    var containerEl = null;     // Container chính, fixed góc dưới trái
    var moreWrapperEl = null;   // Wrapper (position: relative) chứa nút "More"
    var popupEl = null;         // Popup chứa các nút bị tràn
    var popupOpen = false;
    var renderScheduled = false;
    var containerCreating = false;

    /**
     * Đảm bảo container đã được gắn vào document.body rồi mới gọi callback.
     * An toàn với @run-at document-start (lúc đó document.body có thể chưa tồn tại).
     */
    function ensureContainer(callback) {
        if (containerEl) {
            callback();
            return;
        }
        var create = function () {
            containerEl = document.createElement('div');
            containerEl.id = 'finplan-floating-buttons-container';
            Object.assign(containerEl.style, {
                position: 'fixed',
                left: '20px',
                bottom: '20px',
                display: 'flex',
                flexDirection: 'column-reverse', // phần tử DOM đầu tiên nằm dưới cùng
                alignItems: 'flex-start', // các pill rộng ngắn khác nhau, canh trái cho gọn
                gap: '10px',
                zIndex: '2147483000'
            });
            document.body.appendChild(containerEl);
            document.addEventListener('click', onDocumentClick, true);
            callback();
        };

        if (document.body) {
            create();
            return;
        }
        if (containerCreating) return; // tránh tạo nhiều observer song song
        containerCreating = true;
        var observer = new MutationObserver(function () {
            if (document.body) {
                observer.disconnect();
                containerCreating = false;
                create();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    function onDocumentClick(e) {
        if (popupOpen && moreWrapperEl && !moreWrapperEl.contains(e.target)) {
            closePopup();
        }
    }

    function closePopup() {
        popupOpen = false;
        if (popupEl) {
            popupEl.remove();
            popupEl = null;
        }
    }

    function togglePopup(overflowButtons) {
        if (popupOpen) {
            closePopup();
            return;
        }
        popupOpen = true;
        popupEl = document.createElement('div');
        Object.assign(popupEl.style, {
            position: 'absolute',
            bottom: 'calc(100% + 10px)',
            left: '0',
            display: 'flex',
            flexDirection: 'column-reverse',
            alignItems: 'flex-start',
            gap: '10px'
        });
        overflowButtons.forEach(function (btnData) {
            popupEl.appendChild(createButtonEl(btnData, true));
        });
        moreWrapperEl.appendChild(popupEl);
    }

    /**
     * Tạo phần tử DOM cho 1 nút dạng pill (icon + text nằm ngang).
     * @param {Object} btnData - { icon, text, tooltip, onClick }
     * @param {boolean} isInPopup - true nếu nút này nằm trong popup "More"
     */
    function createButtonEl(btnData, isInPopup) {
        var el = document.createElement('div');
        if (btnData.tooltip) el.title = btnData.tooltip;
        Object.assign(el.style, {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            height: '40px',
            padding: '0 16px 0 12px',
            borderRadius: '20px',
            background: '#28a745',
            boxShadow: '0 2px 8px rgba(0,0,0,.25)',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '600',
            color: 'white',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            flexShrink: '0'
        });

        var iconEl = document.createElement('span');
        Object.assign(iconEl.style, {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '18px',
            lineHeight: '1',
            flexShrink: '0'
        });
        var icon = btnData.icon;
        if (typeof icon === 'string' && icon.trim().indexOf('<') === 0) {
            iconEl.innerHTML = icon; // cho phép truyền HTML/SVG nhỏ làm icon
        } else if (icon) {
            iconEl.textContent = icon;
        }
        el.appendChild(iconEl);

        if (btnData.text) {
            var textEl = document.createElement('span');
            textEl.textContent = btnData.text;
            el.appendChild(textEl);
        }

        el.addEventListener('click', function (e) {
            e.stopPropagation();
            if (isInPopup) closePopup();
            try {
                if (typeof btnData.onClick === 'function') btnData.onClick();
            } catch (err) {
                console.error('[FinplanUtils] Lỗi khi xử lý click nút "' + btnData.id + '":', err);
            }
        });
        return el;
    }

    /**
     * Lấy danh sách nút đang visible, sắp xếp theo order asc, id asc (tie-break).
     * Việc tie-break theo id đảm bảo thứ tự hiển thị nhất quán giữa các session,
     * không phụ thuộc thứ tự đăng ký (thứ tự load script).
     */
    function getSortedVisibleButtons() {
        return Array.from(buttonRegistry.entries())
            .filter(function (entry) { return entry[1].visible !== false; })
            .map(function (entry) {
                return Object.assign({ id: entry[0] }, entry[1]);
            })
            .sort(function (a, b) {
                var oa = typeof a.order === 'number' ? a.order : 0;
                var ob = typeof b.order === 'number' ? b.order : 0;
                if (oa !== ob) return oa - ob;
                if (a.id < b.id) return -1;
                if (a.id > b.id) return 1;
                return 0;
            });
    }

    /**
     * Gom nhiều lần thay đổi (register/unregister/update liên tiếp) thành
     * một lần render duy nhất (batch qua microtask) để tránh render thừa.
     */
    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        Promise.resolve().then(function () {
            renderScheduled = false;
            render();
        });
    }

    function render() {
        ensureContainer(function () {
            closePopup();
            containerEl.innerHTML = '';
            moreWrapperEl = null;

            var sorted = getSortedVisibleButtons();

            if (sorted.length <= MAX_VISIBLE_BUTTONS) {
                sorted.forEach(function (data) {
                    containerEl.appendChild(createButtonEl(data, false));
                });
                return;
            }

            // Vượt ngưỡng: hiện (MAX_VISIBLE_BUTTONS - 1) nút ưu tiên cao nhất
            // + 1 nút "More" gom các nút còn lại.
            var directCount = MAX_VISIBLE_BUTTONS - 1;
            var directButtons = sorted.slice(0, directCount);
            var overflowButtons = sorted.slice(directCount);

            directButtons.forEach(function (data) {
                containerEl.appendChild(createButtonEl(data, false));
            });

            moreWrapperEl = document.createElement('div');
            moreWrapperEl.style.position = 'relative';
            var moreBtn = createButtonEl({
                id: '__more__',
                icon: '\u22EF',
                text: '(' + overflowButtons.length + ') more...',
                tooltip: overflowButtons.length + ' nút khác',
                onClick: function () { togglePopup(overflowButtons); }
            }, false);
            moreWrapperEl.appendChild(moreBtn);
            containerEl.appendChild(moreWrapperEl);
        });
    }

    // ------------------------------------------------------------------
    // API công khai
    // ------------------------------------------------------------------

    /**
     * Đăng ký (hoặc cập nhật nếu id đã tồn tại) một floating button.
     *
     * @param {string} id - Định danh duy nhất của nút (nên đặt cố định, không đổi giữa các lần load).
     * @param {Object} options
     * @param {string} options.icon - Ký tự/emoji hoặc chuỗi HTML/SVG ngắn hiển thị làm icon của nút.
     * @param {string} options.text - Chữ hiển thị trực tiếp trên nút, cạnh icon.
     * @param {string} [options.tooltip] - Tooltip khi hover (không hiển thị trực tiếp trên nút).
     * @param {Function} options.onClick - Handler được gọi khi user bấm nút.
     * @param {boolean} [options.visible=true] - Trạng thái hiện/ẩn ban đầu.
     * @param {number} [options.order=0] - Độ ưu tiên sắp xếp, số nhỏ hơn nằm gần đáy màn hình hơn.
     *        Nếu nhiều nút có cùng order (hoặc đều không truyền), thứ tự sẽ được
     *        tie-break theo `id` (a-z) để đảm bảo nhất quán giữa các session.
     */
    unsafeWindow.FinplanUtils.registerButton = function (id, options) {
        if (!id) throw new Error('[FinplanUtils] registerButton yêu cầu tham số "id"');
        options = options || {};
        buttonRegistry.set(id, {
            icon: options.icon,
            text: options.text,
            tooltip: options.tooltip,
            onClick: options.onClick,
            visible: options.visible !== false,
            order: options.order
        });
        scheduleRender();
    };

    /**
     * Huỷ đăng ký một nút, gỡ khỏi danh sách hiển thị.
     * @param {string} id
     */
    unsafeWindow.FinplanUtils.unregisterButton = function (id) {
        if (buttonRegistry.delete(id)) {
            scheduleRender();
        }
    };

    /**
     * Cho phép plugin tự ẩn/hiện nút của mình mà không cần unregister/register lại.
     * @param {string} id
     * @param {boolean} visible
     */
    unsafeWindow.FinplanUtils.setButtonVisible = function (id, visible) {
        var data = buttonRegistry.get(id);
        if (!data) return;
        data.visible = visible !== false;
        scheduleRender();
    };

    /**
     * Cập nhật một phần thông tin của nút đã đăng ký (icon, text, tooltip, onClick, order...).
     * @param {string} id
     * @param {Object} partialOptions
     */
    unsafeWindow.FinplanUtils.updateButton = function (id, partialOptions) {
        var data = buttonRegistry.get(id);
        if (!data) return;
        Object.assign(data, partialOptions || {});
        scheduleRender();
    };
})();