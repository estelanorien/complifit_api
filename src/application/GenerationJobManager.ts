import { EventEmitter } from 'events';

export interface JobProgress {
    jobId: string;
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    status: 'running' | 'completed' | 'failed';
    currentItem?: string;
    error?: string;
}

/**
 * GenerationJobManager - In-memory real-time job tracker.
 * Emits events that are consumed by the SSE (Server-Sent Events) controller.
 */
class GenerationJobManager extends EventEmitter {
    private activeJobs = new Map<string, JobProgress>();

    /**
     * Start a new tracking job.
     */
    createJob(jobId: string, total: number): JobProgress {
        const job: JobProgress = {
            jobId,
            total,
            completed: 0,
            failed: 0,
            skipped: 0,
            status: 'running'
        };
        this.activeJobs.set(jobId, job);
        this.emit(`job:${jobId}`, job);
        return job;
    }

    /**
     * Update progress for a specific job.
     */
    updateProgress(jobId: string, update: Partial<JobProgress>) {
        const job = this.activeJobs.get(jobId);
        if (!job) return;

        Object.assign(job, update);

        // Auto-complete if finished
        if (job.completed + job.failed + job.skipped >= job.total) {
            job.status = 'completed';
        }

        this.emit(`job:${jobId}`, job);

        if (job.status !== 'running') {
            // Keep job in memory for a short duration after completion for slow clients
            setTimeout(() => this.activeJobs.delete(jobId), 10 * 60 * 1000); // 10 minutes
        }
    }

    /**
     * Get the latest state of a job.
     */
    getJob(jobId: string): JobProgress | undefined {
        return this.activeJobs.get(jobId);
    }
}

export const jobManager = new GenerationJobManager();
