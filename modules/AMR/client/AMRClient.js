const HttpClient = require('./HttpClient');
const LocationEndpoint = require('./endpoints/LocationEndpoint');
const BatteryEndpoint = require('./endpoints/BatteryEndpoint');
const CargoEndpoint = require('./endpoints/CargoEndpoint');
const StatusEndpoint = require('./endpoints/StatusEndpoint');
const SensorsEndpoint = require('./endpoints/SensorsEndpoint');

class AMRClient {
    constructor(amrId, baseIP) {
        this.amrId = amrId;
        this.baseIP = baseIP;

        const httpClient = new HttpClient();

        this.endpoints = {
            location: new LocationEndpoint(httpClient, baseIP),
            battery: new BatteryEndpoint(httpClient, baseIP),
            cargo: new CargoEndpoint(httpClient, baseIP),
            status: new StatusEndpoint(httpClient, baseIP),
            sensors: new SensorsEndpoint(httpClient, baseIP)
        };
    }

    async getLocation() {
        return await this.endpoints.location.fetch();
    }

    async getBattery() {
        return await this.endpoints.battery.fetch();
    }

    async getCargo() {
        return await this.endpoints.cargo.fetch();
    }

    async getStatus() {
        return await this.endpoints.status.fetch();
    }

    async getSensors() {
        return await this.endpoints.sensors.fetch();
    }
}

module.exports = AMRClient;
