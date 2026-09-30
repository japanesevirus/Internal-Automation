# Giao tiếp với API MISA MoneyKeeper

Tài liệu này mô tả cách gọi API bên thứ ba của **MISA MoneyKeeper** (app quản lý
chi tiêu cá nhân) — độc lập với bất kỳ project cụ thể nào, để có thể mang sang
dùng ở nơi khác.

**API này không có tài liệu chính thức công khai.** Toàn bộ nội dung dưới đây
suy ra từ quan sát request thật mà chính web app MISA MoneyKeeper gửi (DevTools
> Network), không phải SDK/spec do MISA công bố. Vì vậy hành vi có thể thay đổi
bất cứ lúc nào không báo trước — nếu gặp lỗi lạ (đặc biệt là thiếu header),
cách đáng tin cậy nhất vẫn là tự bắt lại request thật của web app MISA thay vì
đoán.

## 1. Xác thực

Mọi request (push lẫn 3 API GET) đều cần:

```
Authorization: Bearer <token>
Content-Type: application/json
```

`<token>` lấy từ chính phiên đăng nhập web app MISA MoneyKeeper (DevTools >
Network > copy request header) — không có luồng OAuth/API key công khai nào để
tự xin token.

### Header phụ tuỳ chỉnh (`extra_headers`)

Vì đây là API nội bộ không tài liệu, MISA có thể yêu cầu thêm header ngoài
`Authorization` mà không báo trước. Ví dụ thật đã gặp: thiếu header
`X-MISA-ClientId` khiến server trả về:

```
HTTP 400 ValidationFailure — "Tên thiết bị không tìm thấy trong header"
```

Không có cách nào đoán trước đầy đủ tập header cần thiết từ code — cách duy
nhất đáng tin cậy là tự bắt request thật của web app MISA (DevTools > Network)
rồi copy toàn bộ header lạ (không chỉ `Authorization`) vào mọi request gửi đi.
Nên thiết kế client sao cho có 1 chỗ cấu hình "extra headers" tuỳ ý (merge vào
mọi request), thay vì hardcode 1 danh sách cố định — vì danh sách đó có thể
thay đổi theo thời gian hoặc theo tài khoản.

## 2. Endpoint

Tất cả trên host `moneykeeperapp.misa.vn`:

| Việc | Method | URL |
|---|---|---|
| Đẩy giao dịch | POST | `https://moneykeeperapp.misa.vn/g1/api/business/api/v1/transactions/` |
| Lấy danh sách wallet | GET | `https://moneykeeperapp.misa.vn/g1/api/business/api/v1/wallets/addtransaction` |
| Lấy cây category Chi | GET | `https://moneykeeperapp.misa.vn/g1/api/business/api/v1/incomeexpensecategorys/0` |
| Lấy cây category Thu | GET | `https://moneykeeperapp.misa.vn/g1/api/business/api/v1/incomeexpensecategorys/1` |

(URL đẩy giao dịch có thể lệch chút theo phiên bản MISA đang dùng — 3 URL GET
danh mục thường ổn định hơn vì đây là API nội bộ hiếm khi đổi.)

## 3. Đẩy giao dịch (POST transactions)

Body là 1 **danh sách JSON** (dù chỉ đẩy 1 giao dịch, vẫn phải bọc trong `[]`).
Mỗi phần tử là 1 giao dịch, có 3 dạng tuỳ `transactionType`:

### `transactionType: 0` — Chi (debit)

```json
[
  {
    "transactionType": 0,
    "amount": 150000,
    "incomeExpenseCategoryId": "...",
    "incomeExpenseCategoryName": "...",
    "walletId": "...",
    "transactionDate": "2026-09-18T10:30:00",
    "expense": null,
    "moreInfo": { "excludeReport": false, "description": "..." }
  }
]
```

### `transactionType: 1` — Thu (credit)

Cấu trúc giống hệt `0`, chỉ khác giá trị `transactionType: 1`.

### `transactionType: 2` — Chuyển khoản giữa 2 wallet

Không phải thu/chi (chuyển khoản nội bộ giữa 2 ví của cùng 1 user) nên **không
có** `incomeExpenseCategoryId`/`incomeExpenseCategoryName`; thay bằng object
`transfer`:

```json
[
  {
    "transactionType": 2,
    "amount": 600000,
    "walletId": "...",
    "transactionDate": "2026-09-19T23:21:24",
    "moreInfo": { "excludeReport": false, "description": "" },
    "transfer": { "toWalletId": "...", "fcAmount": 22.8 }
  }
]
```

- `walletId` = ví nguồn (tiền đi ra); `transfer.toWalletId` = ví đích (tiền đi
  vào).
- `transfer.fcAmount` = "foreign currency amount" — số tiền quy đổi phía ví
  đích, dùng khi 2 ví khác loại tiền tệ (`amount` luôn tính theo loại tiền của
  ví nguồn). Nếu 2 ví cùng loại tiền tệ, đơn giản nhất là gửi
  `fcAmount = amount`; nếu khác loại tiền tệ và có tỷ giá thật, quy đổi trước
  khi gửi.

### Field chung mọi `transactionType`

| Field | Kiểu | Ghi chú |
|---|---|---|
| `amount` | number | Số tiền, theo loại tiền tệ của `walletId` (ví nguồn) |
| `walletId` | string (GUID) | Lấy từ API "Lấy danh sách wallet" (mục 4) |
| `transactionDate` | string ISO 8601 | Không có mã múi giờ (vd `"2026-09-18T10:30:00"`) |
| `moreInfo.excludeReport` | boolean | Có loại giao dịch này khỏi báo cáo thống kê không |
| `moreInfo.description` | string | Ghi chú/diễn giải giao dịch, hiện trong app MISA |

## 4. Lấy danh sách wallet (GET)

Response là 1 **mảng phẳng** (không phân cấp) các wallet:

```json
[
  {
    "walletId": "ddf7a28c-e7eb-4309-a94d-d15af41d4922",
    "walletName": "Ví MoMo",
    "currencyCode": "VND",
    "walletType": 7
  }
]
```

Field quan trọng:
- `walletId` — dùng làm `walletId`/`transfer.toWalletId` khi đẩy giao dịch.
- `walletName` — tên hiển thị.
- `currencyCode` — mã tiền tệ (`"VND"`, `"USD"`, ...).
- `walletType` — số nguyên phân loại ví, quan sát được các giá trị:

  | `walletType` | Ý nghĩa |
  |---|---|
  | 0 | Ví chung |
  | 1 | Tài khoản ngân hàng |
  | 2 | Thẻ tín dụng |
  | 3 | Đầu tư |
  | 4 | Khác (giá trị mặc định nếu gặp số lạ chưa biết) |
  | 7 | Ví điện tử |

## 5. Lấy cây category (GET)

Response là 1 **cây 2 cấp** (danh sách node cấp 1, mỗi node có thể có
`children` là danh sách node cấp 2):

```json
[
  {
    "incomeExpenseCategoryId": "...",
    "name": "Ăn uống",
    "children": [
      { "incomeExpenseCategoryId": "...", "name": "Ăn ngoài" },
      { "incomeExpenseCategoryId": "...", "name": "Đi chợ" }
    ]
  }
]
```

- `incomeExpenseCategoryId` — dùng làm `incomeExpenseCategoryId` khi đẩy giao
  dịch (có thể lấy từ node cấp 1 HOẶC cấp 2 — cấp 2 cụ thể hơn, nhưng cấp 1
  vẫn hợp lệ để chọn nếu không cần chi tiết).
- `name` — tên thật của category, dùng làm `incomeExpenseCategoryName` khi đẩy
  giao dịch (không phải chuỗi hiển thị ghép kiểu "Cha ► Con" — nếu tự ghép
  chuỗi hiển thị cho UI, giữ `name` gốc riêng để gửi API).
- 2 endpoint khác nhau cho 2 chiều: `/incomeexpensecategorys/0` = cây category
  Chi, `/incomeexpensecategorys/1` = cây category Thu — gọi cây tương ứng với
  hướng giao dịch đang cần.

## 6. Xử lý lỗi

Nên quy mọi lỗi gọi API (lỗi mạng, timeout, HTTP response không phải 2xx, JSON
response không hợp lệ) về **1 loại lỗi chung duy nhất** ở tầng gọi API, không
cần phân biệt nguyên nhân gốc cho code gọi phía trên — vì với API không tài
liệu như thế này, hầu hết lỗi đều nên được coi là "có thể thử lại sau" (retry
sau), không có nhiều giá trị thực tế trong việc phân loại chi tiết hơn ở tầng
gọi.

Với response lỗi HTTP (4xx/5xx), nên đọc + log nguyên văn body response (thường
là JSON dạng `{"message": "..."}` hoặc tương tự) — đây thường là manh mối duy
nhất để biết thiếu header nào hoặc field nào sai định dạng, vì không có tài
liệu tra cứu mã lỗi.

## 7. Ghi chú triển khai

- Không cần thư viện HTTP đặc biệt — `urllib.request`/`fetch`/bất kỳ HTTP
  client chuẩn nào của ngôn ngữ đang dùng đều đủ (API chỉ cần JSON qua
  HTTPS + 1-2 header).
- Không có endpoint "test connection"/"whoami" riêng — cách rẻ nhất để kiểm
  tra token/header còn hợp lệ là gọi thử 1 trong 3 API GET (danh sách wallet
  là nhẹ nhất).
- Không có rate limit nào được biết tới, nhưng vì là API nội bộ không chính
  thức, nên tránh gọi dồn dập không cần thiết (vd cache lại response GET thay
  vì gọi lại mỗi lần cần hiển thị danh sách).
