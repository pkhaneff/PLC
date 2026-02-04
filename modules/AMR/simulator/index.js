const AMRSimulator = require('./AMRSimulator');

const simulators = [];

function startSimulators() {
    const amr1 = new AMRSimulator(
        'AMR001',
        19204,
        { x: 0, y: 0, theta: 0, floor: 1 }
    );

    const amr2 = new AMRSimulator(
        'AMR002',
        19205,
        { x: 10, y: 10, theta: 90, floor: 1 }
    );

    amr1.start();
    amr2.start();

    simulators.push(amr1, amr2);

    console.log('\n=== AMR Simulators Started ===');
    console.log('AMR001: http://127.0.0.1:19204');
    console.log('AMR002: http://127.0.0.1:19205');
    console.log('Movement duration: 3 seconds');
    console.log('Handles all API codes (STATUS, CONTROL, NAVIGATION, CONFIG)\n');
}

function stopSimulators() {
    simulators.forEach((sim) => sim.stop());
    console.log('All simulators stopped');
}

process.on('SIGINT', () => {
    stopSimulators();
    process.exit(0);
});

if (require.main === module) {
    startSimulators();
}

module.exports = { startSimulators, stopSimulators };
