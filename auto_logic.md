
# Shuttle Auto-Mode Workflow

The Shuttle Auto-Mode enables shuttles to operate autonomously by automatically picking up and processing tasks based on predefined logic. The core orchestration is handled by the `ShuttleDispatcherService`.

## Workflow Steps:

1.  **Activation:** The auto-mode can be triggered through an external signal or by calling an API endpoint (e.g., `/api/v1/shuttle/auto-mode`).
2.  **Dispatcher Initialization:** Upon activation, the `ShuttleDispatcherService` starts its periodic dispatch cycle (e.g., every 5 seconds) to find and assign tasks.
3.  **Task Retrieval (FIFO):**
    *   The dispatcher queries the `shuttleTaskQueueService` to fetch the next available `pending` task in a First-In, First-Out (FIFO) order.
    *   If no pending tasks are found, the dispatcher waits for the next cycle.
4.  **Pickup Node Locking:**
    *   To prevent race conditions and ensure orderly task acquisition, the dispatcher attempts to acquire a distributed lock on the task's `pickupNode` using `ReservationService`. This lock ensures that only one dispatcher instance or task can proceed with acquiring resources for this pickup node at a time.
    *   If the pickup node is already locked, the current dispatch cycle for this task is aborted, and it will be retried later.
5.  **Shuttle Availability Check:**
    *   The dispatcher retrieves the real-time states of all shuttles from `shuttleStateCache`.
    *   It filters for shuttles currently in the `IDLE` status (status code 8).
6.  **Optimal Shuttle Selection:**
    *   If idle shuttles are available, the dispatcher identifies the most optimal shuttle for the task. This involves:
        *   Retrieving the geographic coordinates (`col`, `row`, `floor_id`) of the task's `pickupNode` using `cellService.getCellByName()`.
        *   For each idle shuttle, retrieving its current location's QR code and then its coordinates using `cellService.getCellByQrCode()`.
        *   Calculating a distance heuristic (e.g., Manhattan distance, with penalties for floor changes) between the shuttle's current location and the task's pickup node.
        *   Selecting the shuttle with the shortest estimated travel distance.
7.  **Path Calculation:**
    *   Once an optimal shuttle is identified, the dispatcher calculates the path from the shuttle's current location to the task's `pickupNode` using the `findShortestPath` function.
    *   **Constraint:** Currently, pathfinding is limited to within a single floor. If the shuttle and the pickup node are on different floors, the task will be retried later.
8.  **Task Assignment and Command Dispatch:**
    *   If a valid path is found and all conditions are met:
        *   The task's status is updated to `assigned` in the `shuttleTaskQueueService`, noting the assigned shuttle ID.
        *   A command is sent to the assigned shuttle via MQTT (using `publishToTopic`) on its specific command topic. This command includes the calculated path, task details, and instructions for when the shuttle arrives at the pickup node (e.g., `onArrival: 'signalPickupComplete'`).
9.  **Error Handling and Retries:**
    *   If at any stage (e.g., pickup node not found, no idle shuttles, no path found, cross-floor pathfinding attempt) the dispatch process cannot be completed, the task is marked for retry.
    *   If a pickup node lock was acquired but the task was not successfully assigned due to subsequent issues, the lock is released using `ReservationService.releaseLock()` to allow other processes to attempt the task.

This workflow ensures that tasks are processed efficiently and orderly, leveraging real-time shuttle states, a robust task queue, and a distributed locking mechanism for resource contention.
