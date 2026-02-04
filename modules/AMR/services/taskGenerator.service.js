const { v4: uuidv4 } = require('uuid');

class TaskGeneratorService {
    generateMoveTaskList(path, action) {
        if (!path || path.length === 0) {
            throw new Error('Path cannot be empty');
        }

        const moveTaskList = [];

        for (let i = 0; i < path.length - 1; i++) {
            const task = {
                id: path[i + 1],
                source_id: path[i],
                task_id: this.generateTaskId()
            };

            if (action && i === 0) {
                task.operation = 'JackLoad';
            }

            if (action && i === path.length - 2) {
                task.operation = 'JackUnload';
            }

            moveTaskList.push(task);
        }

        return { move_task_list: moveTaskList };
    }

    generateTaskId() {
        return uuidv4().replace(/-/g, '').substring(0, 8);
    }
}

module.exports = new TaskGeneratorService();
