const pool = require('../../config/database');

class ShuttleService {
  async createShuttle(shuttleId, startNode, targetNode, path) {
    const now = Date.now();
    const query = `
      INSERT INTO shuttle_sessions (
        id, status, start_node, current_node, target_node,
        current_step_index, registered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    await pool.execute(query, [
      shuttleId,
      'registered',
      startNode,
      startNode,
      targetNode,
      0,
      now
    ]);

    if (path && path.length > 0) {
      await this.savePath(shuttleId, path, false);
    }

    return this.getShuttle(shuttleId);
  }

  async savePath(shuttleId, path, isBackupPath = false) {
    const deleteQuery = `
      DELETE FROM shuttle_paths
      WHERE shuttle_id = ? AND is_backup_path = ?
    `;
    await pool.execute(deleteQuery, [shuttleId, isBackupPath]);

    if (path && path.length > 0) {
      const insertQuery = `
        INSERT INTO shuttle_paths (shuttle_id, step_index, qr_code, is_backup_path)
        VALUES (?, ?, ?, ?)
      `;

      for (let i = 0; i < path.length; i++) {
        await pool.execute(insertQuery, [shuttleId, i, path[i], isBackupPath]);
      }
    }
  }

  async getShuttle(shuttleId) {
    const query = `
      SELECT * FROM shuttle_sessions WHERE id = ?
    `;
    const [rows] = await pool.execute(query, [shuttleId]);

    if (rows.length === 0) return null;

    const shuttle = rows[0];
    shuttle.path = await this.getPath(shuttleId, false);
    shuttle.rerouteBackupPath = await this.getPath(shuttleId, true);
    shuttle.reservedNodes = await this.getReservedNodes(shuttleId);
    shuttle.conflicts = await this.getConflicts(shuttleId);

    return shuttle;
  }

  async getPath(shuttleId, isBackupPath = false) {
    const query = `
      SELECT qr_code
      FROM shuttle_paths
      WHERE shuttle_id = ? AND is_backup_path = ?
      ORDER BY step_index ASC
    `;
    const [rows] = await pool.execute(query, [shuttleId, isBackupPath]);
    return rows.map(r => r.qr_code);
  }

  async setShuttleWaiting(shuttleId, waitingSince) {
    const query = `
      UPDATE shuttle_sessions
      SET status = 'waiting', waiting_since = ?
      WHERE id = ?
    `;
    await pool.execute(query, [waitingSince, shuttleId]);
  }

  async clearShuttleWaiting(shuttleId) {
    const query = `
      UPDATE shuttle_sessions
      SET status = 'running', waiting_since = NULL, reroute_started_at = NULL
      WHERE id = ?
    `;
    await pool.execute(query, [shuttleId]);

    await this.clearConflicts(shuttleId);
    await this.savePath(shuttleId, [], true);
  }

  async setShuttleCompleted(shuttleId) {
    const now = Date.now();
    const query = `
      UPDATE shuttle_sessions
      SET status = 'completed', completed_at = ?
      WHERE id = ?
    `;
    await pool.execute(query, [now, shuttleId]);
  }

  async setRerouteBackup(shuttleId, backupPath) {
    const now = Date.now();
    const query = `
      UPDATE shuttle_sessions
      SET reroute_started_at = ?
      WHERE id = ?
    `;
    await pool.execute(query, [now, shuttleId]);

    await this.savePath(shuttleId, backupPath, true);
  }

  async applyReroute(shuttleId, newPath) {
    const query = `
      UPDATE shuttle_sessions
      SET status = 'rerouting', current_step_index = 0,
          waiting_since = NULL
      WHERE id = ?
    `;
    await pool.execute(query, [shuttleId]);

    await this.savePath(shuttleId, newPath, false);
    await this.clearConflicts(shuttleId);
  }

  async removeShuttle(shuttleId) {
    const query = `DELETE FROM shuttle_sessions WHERE id = ?`;
    const [result] = await pool.execute(query, [shuttleId]);
    return result.affectedRows > 0;
  }

  async getAllShuttles() {
    const query = `SELECT * FROM shuttle_sessions ORDER BY registered_at DESC`;
    const [rows] = await pool.execute(query);

    const shuttles = [];
    for (const row of rows) {
      row.path = await this.getPath(row.id, false);
      row.rerouteBackupPath = await this.getPath(row.id, true);
      row.reservedNodes = await this.getReservedNodes(row.id);
      row.conflicts = await this.getConflicts(row.id);
      shuttles.push(row);
    }

    return shuttles;
  }

  async getActiveShuttles() {
    const query = `
      SELECT * FROM shuttle_sessions
      WHERE status != 'completed'
      ORDER BY registered_at ASC
    `;
    const [rows] = await pool.execute(query);

    const shuttles = [];
    for (const row of rows) {
      row.path = await this.getPath(row.id, false);

    return shuttles;
  }
}

  async reserveNode(shuttleId, qrCode) {
    const now = Date.now();
    const query = `
      INSERT INTO shuttle_reserved_nodes (shuttle_id, qr_code, reserved_at)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE reserved_at = ?
    `;
    await pool.execute(query, [shuttleId, qrCode, now, now]);
  }

  async unreserveNode(shuttleId, qrCode) {
    const query = `
      DELETE FROM shuttle_reserved_nodes
      WHERE shuttle_id = ? AND qr_code = ?
    `;
    await pool.execute(query, [shuttleId, qrCode]);
  }

  async getReservedNodes(shuttleId) {
    const query = `
      SELECT qr_code
      FROM shuttle_reserved_nodes
      WHERE shuttle_id = ?
      ORDER BY reserved_at ASC
    `;
    const [rows] = await pool.execute(query, [shuttleId]);
    return rows.map(r => r.qr_code);
  }

  async getNodeBlocker(qrCode) {
    const query = `
      SELECT shuttle_id
      FROM shuttle_reserved_nodes
      WHERE qr_code = ?
      LIMIT 1
    `;
    const [rows] = await pool.execute(query, [qrCode]);
    return rows.length > 0 ? rows[0].shuttle_id : null;
  }

  async isNodeBlocked(qrCode) {
    const blocker = await this.getNodeBlocker(qrCode);
    return blocker !== null;
  }

  async addConflict(shuttleId, conflictWith) {
    const now = Date.now();
    const query = `
      INSERT IGNORE INTO shuttle_conflicts (shuttle_id, conflict_with, detected_at)
      VALUES (?, ?, ?)
    `;
    await pool.execute(query, [shuttleId, conflictWith, now]);
  }

  async getConflicts(shuttleId) {
    const query = `
      SELECT conflict_with
      FROM shuttle_conflicts
      WHERE shuttle_id = ?
    `;
    const [rows] = await pool.execute(query, [shuttleId]);
    return rows.map(r => r.conflict_with);
  }

  async clearConflicts(shuttleId) {
    const query = `DELETE FROM shuttle_conflicts WHERE shuttle_id = ?`;
    await pool.execute(query, [shuttleId]);
  }

  async clearAll() {
    await pool.execute('DELETE FROM shuttle_sessions');
  }
}

module.exports = new ShuttleService();
