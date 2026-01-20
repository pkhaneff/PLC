# Quy trình Nhập hàng Tự động (Unified Inbound Logic)

Tài liệu này mô tả logic điều phối Shuttle và Lifter cho quá trình nhập hàng, bao gồm cả các kịch bản cùng tầng và khác tầng.

## 1. Tìm kiếm Ô lưu kho (Global Storage Discovery)
Khi có pallet mới tại điểm lấy (Pickup Node):
- **Ưu tiên Tầng hiện tại**: Hệ thống tìm kiếm ô trống phù hợp với loại pallet trên cùng tầng với Pickup Node.
- **Quét toàn bộ Warehouse**: Nếu tầng hiện tại hết chỗ, hệ thống sẽ tự động tìm kiếm trên tất cả các tầng (ưu tiên `floor_id` thấp trước - FIFO).
- **Kết quả**: Xác định được `TargetNode` và `TargetFloor`.

## 2. Điều phối Chặng 1: Di chuyển tới Điểm lấy hàng
`ShuttleDispatcherService` sẽ chọn Shuttle tối ưu (Idle):
- **Khoảng cách**: Ưu tiên Shuttle gần nhất.
- **Khác tầng**: Nếu Shuttle ở tầng khác, hệ thống sẽ tự động chèn chặng di chuyển qua Lifter.
- **Navigator**: Sử dụng `MissionCoordinatorService.calculateNextSegment` để tính toán đường đi.
    - Nếu khác tầng -> Đích tạm thời là Lifter Node.
    - Nếu cùng tầng -> Đích là Pickup Node.

## 3. Xử lý tại Lifter (Automated Lifter Control)
Khi bất kỳ Shuttle nào báo sự kiện `ARRIVED_AT_LIFTER`:
1. **Ánh xạ tầng**: Tự động chuyển ID tầng DB (138, 139) sang chỉ số vật lý (1, 2).
2. **Kích hoạt PLC**: Server gửi lệnh điều khiển Lifter di chuyển tới `targetFloor`.
3. **Giám sát**: Server đợi sensor báo đã tới tầng đích.
4. **Tính toán lại**: Ngay khi tới nơi, Shuttle tự động tính toán chặng tiếp theo để ra khỏi Lifter về phía mục tiêu.

## 4. Xử lý sau khi Lấy hàng (Post-Pickup Logic)
Sau khi nhận sự kiện `PICKUP_COMPLETE`:
- **Đánh giá Đích**: Kiểm tra `TargetNode` có cùng tầng không.
- **Ra quyết định**:
    - **Cùng tầng**: Di chuyển thẳng tới ô lưu kho.
    - **Khác tầng**: Di chuyển tới Lifter (ưu tiên node T4: `X5555Y5555`).
    - **Row Coordination**: Đảm bảo tuân thủ hướng di chuyển một chiều (LEFT_TO_RIGHT) khi đi vào hàng kệ.

## 5. Kết thúc nhiệm vụ
Khi nhận sự kiện `TASK_COMPLETE`:
1. **Cập nhật dữ liệu**: Đánh dấu ô kệ đã có hàng (`is_has_box = 1`).
2. **Giải phóng tài nguyên**: Giải phóng Lock của ô kệ.
3. **Trạng thái**: Chuyển Shuttle về `IDLE` và sẵn sàng cho nhiệm vụ tiếp theo (có thể quay lại tầng khác nếu có lệnh mới).

---

### Các thành phần cốt lõi:
- **`MissionCoordinatorService`**: "Bộ não" tính toán lộ trình thông minh cho mọi tình huống.
- **`LifterService`**: Quản lý ánh xạ tầng và điều khiển trực tiếp qua PLC.
- **`TaskEventListener`**: Trung tâm điều phối các sự kiện phản hồi từ Shuttle.
