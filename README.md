# NodeS7_simple - Hệ thống điều phối Shuttle WCS

Dự án Node.js mô phỏng và điều khiển hệ thống kho tự động (Warehouse Control System) sử dụng xe tự hành (shuttle).

## Kiến trúc Giả lập Quy trình Shuttle (Cập nhật)

Hệ thống đã được nâng cấp để sử dụng kiến trúc hướng sự kiện (event-driven) thông qua MQTT, giúp mô phỏng hoạt động của các shuttle một cách chính xác, hiệu quả và real-time hơn. Logic xử lý trạng thái không còn phụ thuộc vào việc truy vấn CSDL liên tục.

### 1. Sơ đồ và Luồng hoạt động

```
+--------------------------+     (3. Gửi lệnh + lộ trình)     +--------------------------+
| shuttleDispatcherService | ----------------------------> |       MQTT Broker        |
+--------------------------+     (Topic: shuttle/command/X)  +--------------------------+
           ^                                                              |
           | (2. Tìm shuttle rảnh)                                        | (4. Agent nhận lệnh)
           |                                                              |
+--------------------------+     (5. Agent báo cáo vị trí)      +--------------------------+
|    shuttleStateCache     | <---------------------------- |   shuttle_simulator.js   |
| (Nguồn trạng thái thật)  |     (Topic: shuttle/info/X)     |      (Shuttle Agents)    |
+--------------------------+                                 +--------------------------+
           ^                                                              |
           | (1. Cập nhật cache)                                          | (6. Di chuyển & Xử lý xung đột)
           |                                                              |
           +--------------------------------------------------------------+
```

1.  **Cập nhật Cache**: Server (`mqttService`) lắng nghe mọi tin nhắn báo cáo trạng thái từ các shuttle agent và cập nhật vào `shuttleStateCache`.
2.  **Tìm Shuttle**: `shuttleDispatcherService` lấy task mới từ hàng đợi (FIFO) và tìm shuttle phù hợp bằng cách truy vấn `shuttleStateCache` để tìm shuttle có trạng thái `IDLE`.
3.  **Gửi Lệnh**: Sau khi tìm được lộ trình, Dispatcher gửi một **lệnh di chuyển** (chứa toàn bộ lộ trình) đến shuttle agent được chọn thông qua MQTT (topic `shuttle/command/{mã_shuttle}`).
4.  **Nhận Lệnh**: Shuttle agent (`shuttle_simulator.js`) nhận được lệnh và lộ trình được giao.
5.  **Báo cáo Trạng thái**: Agent bắt đầu quá trình di chuyển và liên tục gửi trạng thái (vị trí `qrCode`, status,...) của mình về server qua MQTT (topic `shuttle/information/{mã_shuttle}`).
6.  **Tự chủ Di chuyển**: Agent tự quản lý việc di chuyển của mình:
    *   **Độ trễ**: Mô phỏng thời gian di chuyển giữa 2 node là **3 giây**.
    *   **Xử lý Xung đột**: Trước khi đến node tiếp theo, agent sẽ kiểm tra xem node đó có bị agent khác chiếm giữ không. Nếu có, nó sẽ vào trạng thái `WAITING` và chờ cho đến khi node được giải phóng.

### 2. Các thành phần chính

*   **`shuttleDispatcherService`**: Não bộ của hệ thống. Chỉ làm nhiệm vụ điều phối: Giao task và gửi lệnh di chuyển ban đầu. Không còn trực tiếp mô phỏng hay cập nhật vị trí của shuttle.
*   **`shuttleStateCache`**: Bộ đệm trạng thái trong bộ nhớ. Là **nguồn sự thật duy nhất** (single source of truth) cho trạng thái real-time của toàn bộ đội xe shuttle trên server.
*   **`shuttle_simulator.js`**: Giả lập các **Shuttle Agent** vật lý. Mỗi agent có khả năng:
    *   Nhận lệnh từ server.
    *   Tự thực thi lộ trình được giao với độ trễ thực tế.
    *   Tự xử lý các xung đột cơ bản với các agent khác.
    *   Báo cáo trạng thái của bản thân một cách liên tục.
*   **MQTT Broker (`Aedes`)**: Trung tâm giao tiếp, giúp các thành phần trao đổi thông điệp một cách bất đồng bộ.

### 3. Cách chạy mô phỏng

1.  **Mở Terminal 1** và khởi động server:
    ```bash
    npm start
    ```
    Server sẽ khởi động cùng với MQTT Broker.

2.  **Mở Terminal 2** và khởi động các shuttle agent:
    ```bash
    node shuttle_simulator.js
    ```
    Các agent sẽ khởi tạo, báo cáo trạng thái `IDLE` và chờ lệnh từ `shuttleDispatcherService`. Khi có task, bạn sẽ thấy dispatcher giao việc và các agent bắt đầu di chuyển trong log.
