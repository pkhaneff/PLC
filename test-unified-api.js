const { manager } = require('./modules/AMR');

async function demoMovement() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║       AMR MOVEMENT DEMO - Pathfinding + Control       ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
        console.log('📍 Task Request:');
        console.log('   Start: LM2');
        console.log('   End:   LM10');
        console.log('   Action: JackLoad\n');

        const result = await manager.executeTask('AMR001', {
            start: 'LM2',
            end: 'LM10',
            action: 'JackLoad',
        });

        console.log('✅ Path Generated:');
        result.data.move_task_list.forEach((task, index) => {
            console.log(
                `   ${index + 1}. ${task.source_id} → ${task.id}` +
                `${task.operation ? ` [${task.operation}]` : ''}`
            );
        });

        console.log('\n🤖 Robot is executing... Watch simulator logs below:\n');
        console.log('─'.repeat(60));

        const totalTime = result.data.move_task_list.length * 3;
        console.log(`\n⏱️  Estimated completion: ${totalTime} seconds\n`);

        await new Promise((resolve) => setTimeout(resolve, totalTime * 1000 + 1000));

        console.log('\n✅ Demo completed!\n');
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
    }

    process.exit(0);
}

demoMovement();
