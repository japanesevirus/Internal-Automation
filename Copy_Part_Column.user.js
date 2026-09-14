// ==UserScript==
// @name         Copy Part Column Text (SPA Optimized)
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  Lấy text từ các thẻ span trong cột "Part" và copy vào clipboard, tối ưu cho SPA
// @author       Gemini
// @match        https://finplan.saigontechnology.vn/*
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // Hàm lấy dữ liệu và copy
    function getPartData() {
        const table = document.querySelector("table.m-datatable__table");
        if (!table) return;

        const headers = Array.from(table.querySelectorAll("thead th"));
        const partColumnIndex = headers.findIndex(th => th.innerText.trim().includes("Part"));

        if (partColumnIndex === -1) return;

        const rows = Array.from(table.querySelectorAll("tbody tr"));
        const collectedText = rows.map(row => {
            const targetCell = row.cells[partColumnIndex];
            if (targetCell) {
                const span = targetCell.querySelector("span.text-bold");
                return span ? span.innerText.trim() : "";
            }
            return "";
        }).filter(text => text !== "").join(" ");

        if (collectedText) {
            GM_setClipboard(collectedText);
            console.log("Đã copy dữ liệu cột Part.");
        }
    }

    // Hàm chèn nút bấm (Không cảnh báo nếu không thấy cột)
    function injectButton() {
        const table = document.querySelector("table.m-datatable__table");
        if (!table) return;

        const headers = Array.from(table.querySelectorAll("thead th"));
        const partHeader = headers.find(th => th.innerText.trim().includes("Part"));

        // Chỉ chèn nếu tìm thấy header "Part" và chưa có nút bấm
        if (partHeader && !partHeader.querySelector(".btn-copy-part")) {
            const btn = document.createElement("button");
            btn.innerText = "📋 Copy";
            btn.className = "btn-copy-part";

            // Style cơ bản cho nút
            Object.assign(btn.style, {
                marginLeft: "8px",
                padding: "2px 5px",
                cursor: "pointer",
                fontSize: "11px",
                borderRadius: "4px",
                border: "1px solid #ccc",
                backgroundColor: "#fff"
            });

            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                getPartData();
            };

            partHeader.appendChild(btn);
        }
    }

    /**
     * TỐI ƯU CHO SPA: Theo dõi thay đổi của DOM
     * Khi Angular render lại table hoặc chuyển trang, observer sẽ phát hiện và chèn lại nút
     */
    const observer = new MutationObserver((mutations) => {
        injectButton();
    });

    // Bắt đầu theo dõi toàn bộ thay đổi trong body
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Chạy lần đầu tiên
    injectButton();
})();