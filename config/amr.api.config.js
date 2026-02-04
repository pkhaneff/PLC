/**
 * AMR API Configuration
 * Định nghĩa cấu trúc API phân cấp cho hệ thống AMR
 * - Simulator xử lý tất cả API codes trên cùng 1 PORT
 * - Mỗi endpoint con có mã request code để thực hiện nhiệm vụ cụ thể
 */

const AMR_API_CONFIG = {
    // API lấy trạng thái robot
    STATUS_API: {
        PORT: 19204, // AMR001 uses 19204, AMR002 uses 19205
        ENDPOINTS: {
            ROBOT_STATUS_LOC_REQ: 1004, // Lấy vị trí hiện tại của robot
        },
    },

    // API điều khiển robot
    CONTROL_API: {
        PORT: 19204, // Same port as STATUS_API - simulator handles all codes
        ENDPOINTS: {
            ROBOT_CONTROL_RELOC_REQ: 2002, // Yêu cầu định vị lại robot
            ROBOT_CONTROL_MOTION_REQ: 2010, // Yêu cầu di chuyển
            ROBOT_CONTROL_STOP_REQ: 2000, // Yêu cầu dừng robot
        },
    },

    // API điều hướng và nhiệm vụ
    NAVIGATION_API: {
        PORT: 19204, // Same port as STATUS_API - simulator handles all codes
        ENDPOINTS: {
            ROBOT_TASK_GOTARGETLIST_REQ: 3066, // Đi đến danh sách điểm đích
            ROBOT_TASK_GOTARGET_REQ: 3051, // Đi đến một điểm đích
            ROBOT_TASK_CANCEL_REQ: 3003, // Hủy nhiệm vụ
            ROBOT_TASK_PAUSE_REQ: 3001, // Tạm dừng nhiệm vụ
            ROBOT_TASK_RESUME_REQ: 3002, // Tiếp tục nhiệm vụ
            ROBOT_TASK_TRANSLATE_REQ: 3055, // Di chuyển tịnh tiến
            ROBOT_TASK_TURN_REQ: 3056, // Xoay robot
            ROBOT_TASK_CIRCULAR_REQ: 3058, // Di chuyển theo cung tròn
        },
    },

    // API cấu hình hệ thống
    CONFIGURATION_API: {
        PORT: 19204, // Same port as STATUS_API - simulator handles all codes
        ENDPOINTS: {
            ROBOT_CONFIG_LOCK_REQ: 4005, // Khóa cấu hình
            ROBOT_CONFIG_DOWNLOADMAP_REQ: 4011, // Tải bản đồ xuống
            ROBOT_UPLOAD_AND_SWITCH_MAP_REQ: 4488, // Tải lên và chuyển bản đồ
        },
    },
};

/**
 * Helper function để lấy thông tin API theo tên
 * @param {string} apiName - Tên API (STATUS_API, CONTROL_API, etc.)
 * @returns {object} Thông tin API bao gồm PORT và ENDPOINTS
 */
function getApiConfig(apiName) {
    return AMR_API_CONFIG[apiName];
}

/**
 * Helper function để lấy endpoint code
 * @param {string} apiName - Tên API
 * @param {string} endpointName - Tên endpoint
 * @returns {number} Mã request code
 */
function getEndpointCode(apiName, endpointName) {
    const api = AMR_API_CONFIG[apiName];
    return api?.ENDPOINTS?.[endpointName];
}

/**
 * Helper function để lấy tất cả ports
 * @returns {object} Object chứa tất cả ports
 */
function getAllPorts() {
    return {
        STATUS_API: AMR_API_CONFIG.STATUS_API.PORT,
        CONTROL_API: AMR_API_CONFIG.CONTROL_API.PORT,
        NAVIGATION_API: AMR_API_CONFIG.NAVIGATION_API.PORT,
        CONFIGURATION_API: AMR_API_CONFIG.CONFIGURATION_API.PORT,
    };
}

module.exports = {
    AMR_API_CONFIG,
    getApiConfig,
    getEndpointCode,
    getAllPorts,
};
