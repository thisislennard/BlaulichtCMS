import os from 'node:os';
import path from 'node:path';

/**
 * PID-Datei des Supervisors (im Container /tmp, tmpfs – nach einem Neustart leer). Über sie hält
 * `cli.js rotate-master-key` API und Worker an (SIGUSR1) und startet sie wieder (SIGUSR2).
 */
export const supervisorPidFile = () => process.env.BLAULICHTCMS_SUPERVISOR_PID_FILE ?? path.join(os.tmpdir(), 'blaulichtcms-supervisor.pid');
