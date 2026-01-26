const { logger } = require('../logger/logger');

/**
 * Dependency Injection Container
 * Quản lý dependencies và lifecycle của các services
 * Tuân thủ Dependency Inversion Principle
 */
class DIContainer {
    constructor() {
        this.services = new Map();
        this.instances = new Map();
        this.initializing = new Set();
    }

    /**
     * Đăng ký một service
     * @param {string} name - Tên service
     * @param {Function} factory - Factory function để tạo service
     * @param {boolean} singleton - Có phải singleton không (default: true)
     */
    register(name, factory, singleton = true) {
        if (this.services.has(name)) {
            logger.warn(`[DIContainer] Service '${name}' is already registered. Overwriting...`);
        }

        this.services.set(name, {
            factory,
            singleton
        });

        logger.debug(`[DIContainer] Registered service: ${name} (singleton: ${singleton})`);
    }

    /**
     * Resolve một service
     * @param {string} name - Tên service
     * @returns {*} Service instance
     */
    resolve(name) {
        // Check if service is registered
        if (!this.services.has(name)) {
            throw new Error(`Service '${name}' is not registered in the container`);
        }

        const service = this.services.get(name);

        // If singleton and already instantiated, return cached instance
        if (service.singleton && this.instances.has(name)) {
            return this.instances.get(name);
        }

        // Check for circular dependencies
        if (this.initializing.has(name)) {
            throw new Error(`Circular dependency detected for service '${name}'`);
        }

        // Create instance
        this.initializing.add(name);

        try {
            const instance = service.factory(this);

            // Cache if singleton
            if (service.singleton) {
                this.instances.set(name, instance);
            }

            this.initializing.delete(name);

            logger.debug(`[DIContainer] Resolved service: ${name}`);
            return instance;
        } catch (error) {
            this.initializing.delete(name);
            logger.error(`[DIContainer] Error resolving service '${name}':`, error.message);
            throw error;
        }
    }

    /**
     * Kiểm tra service đã được đăng ký chưa
     * @param {string} name - Tên service
     * @returns {boolean}
     */
    has(name) {
        return this.services.has(name);
    }

    /**
     * Xóa một service khỏi container
     * @param {string} name - Tên service
     */
    unregister(name) {
        this.services.delete(name);
        this.instances.delete(name);
        logger.debug(`[DIContainer] Unregistered service: ${name}`);
    }

    /**
     * Clear tất cả services
     */
    clear() {
        this.services.clear();
        this.instances.clear();
        this.initializing.clear();
        logger.info('[DIContainer] Cleared all services');
    }

    /**
     * Dispose tất cả services (gọi dispose method nếu có)
     */
    async dispose() {
        logger.info('[DIContainer] Disposing all services...');

        const disposePromises = [];

        for (const [name, instance] of this.instances.entries()) {
            if (instance && typeof instance.dispose === 'function') {
                logger.debug(`[DIContainer] Disposing service: ${name}`);
                disposePromises.push(instance.dispose());
            } else if (instance && typeof instance.close === 'function') {
                logger.debug(`[DIContainer] Closing service: ${name}`);
                disposePromises.push(instance.close());
            }
        }

        await Promise.all(disposePromises);

        this.clear();
        logger.info('[DIContainer] All services disposed');
    }

    /**
     * Lấy danh sách tất cả services đã đăng ký
     * @returns {Array<string>}
     */
    getRegisteredServices() {
        return Array.from(this.services.keys());
    }

    /**
     * Lấy danh sách tất cả instances đã được tạo
     * @returns {Array<string>}
     */
    getInstances() {
        return Array.from(this.instances.keys());
    }
}

module.exports = DIContainer;
