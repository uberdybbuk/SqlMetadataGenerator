using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Data.SqlClient;
using SqlMetadataGenerator.Scripting;

namespace SqlMetadataGenerator.Web;

// Script generation as a job: started by one request, watched by others, its output kept on disk.
//
// On a large database a script took minutes inside a single request, and the page could only say
// "Scripting…" until it came back. As a job, the page asks where it is twice a second and shows the
// phases. The output goes to a file rather than into the response, so a script of a hundred
// megabytes reaches the browser as an ordinary download and never sits in the page's memory.
//
// Two clocks clean up after it:
//   * A finished job's file is kept for the time the request asked for (the "download again"
//     window), then deleted.
//   * A running job nobody has asked about for a while is cancelled. The tab was closed, and a
//     read of fifty thousand modules should not go on for nobody.
public sealed class ScriptJobs(ILogger<ScriptJobs> log) : IDisposable
{
    public enum JobState
    {
        Running,
        Done,
        Failed,
        Cancelled,
    }

    // Kind is "script" (one .sql) or "files" (the archive). Lines only for a script.
    public sealed record Output(
        string Kind,
        string Path,
        string FileName,
        string ContentType,
        long Bytes,
        long? Lines,
        int Scripted,
        IReadOnlyList<string> Missing,
        IReadOnlyList<string> CycleTables);

    public sealed class Job(string id, TimeSpan keep)
    {
        public string Id { get; } = id;
        public TimeSpan Keep { get; } = keep;
        public ScriptProgress Progress { get; } = new();
        public Stopwatch Clock { get; } = Stopwatch.StartNew();
        internal CancellationTokenSource Cancellation { get; } = new();

        // Written by the job's own task, read by the requests watching it. Each is replaced as a
        // whole, never changed in place, so a reader sees the old value or the new one.
        public JobState State { get; internal set; } = JobState.Running;
        public string? Error { get; internal set; }
        public Output? Result { get; internal set; }
        internal DateTime? FinishedAt { get; set; }
        internal DateTime LastSeen { get; set; } = DateTime.UtcNow;
    }

    // Nobody asked for this long: the page is gone.
    private static readonly TimeSpan Abandoned = TimeSpan.FromMinutes(2);

    private readonly ConcurrentDictionary<string, Job> jobs = new();
    private readonly string folder = PrepareFolder();
    private readonly Lock gate = new();
    // Started with the first job: a server nobody scripts on has nothing to sweep.
    private Timer? sweeper;

    // What an earlier run left behind belongs to jobs this process never knew.
    private static string PrepareFolder()
    {
        string path = Path.Combine(Path.GetTempPath(), "SqlMetadataGenerator", "scripts");
        if (Directory.Exists(path))
        {
            Directory.Delete(path, recursive: true);
        }
        Directory.CreateDirectory(path);
        return path;
    }

    // The file a job writes, without its extension: the work adds the one that fits.
    public string PathFor(Job job) => Path.Combine(folder, job.Id);

    public Job Start(TimeSpan keep, Func<Job, CancellationToken, Task<Output>> work)
    {
        lock (gate)
        {
            sweeper ??= new Timer(_ => Sweep(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
        }

        var job = new Job(Guid.NewGuid().ToString("N"), keep);
        jobs[job.Id] = job;

        // Not the request's token: the request ends as soon as the id is sent back.
        _ = Task.Run(async () =>
        {
            try
            {
                job.Result = await work(job, job.Cancellation.Token);
                job.State = JobState.Done;
            }
            catch (OperationCanceledException) when (job.Cancellation.IsCancellationRequested)
            {
                job.State = JobState.Cancelled;
                DeleteFiles(job);
            }
            catch (Exception ex)
            {
                job.Error = Describe(ex);
                job.State = JobState.Failed;
                DeleteFiles(job);
                if (ex is not (InvalidOperationException or CatalogTimeoutException or SqlException))
                {
                    log.LogError(ex, "Script job {Id} failed", job.Id);
                }
            }
            finally
            {
                job.Clock.Stop();
                job.FinishedAt = DateTime.UtcNow;
            }
        });

        return job;
    }

    // Asking about a job is what keeps a running one alive.
    public Job? Find(string id)
    {
        if (!jobs.TryGetValue(id, out var job))
        {
            return null;
        }
        job.LastSeen = DateTime.UtcNow;
        return job;
    }

    // Stops a running job, or throws a finished one's file away. Either way it is gone after this.
    public bool Remove(string id)
    {
        if (!jobs.TryRemove(id, out var job))
        {
            return false;
        }
        job.Cancellation.Cancel();
        if (job.State != JobState.Running)
        {
            DeleteFiles(job);
        }
        return true;
    }

    private void Sweep()
    {
        var now = DateTime.UtcNow;
        foreach (var job in jobs.Values)
        {
            if (job.State == JobState.Running && now - job.LastSeen > Abandoned)
            {
                log.LogInformation("Script job {Id} cancelled: nobody has asked about it for {Minutes} minutes", job.Id, Abandoned.TotalMinutes);
                Remove(job.Id);
            }
            else if (job.FinishedAt is { } finished && now - finished > job.Keep)
            {
                Remove(job.Id);
            }
        }
    }

    private void DeleteFiles(Job job)
    {
        try
        {
            foreach (string file in Directory.EnumerateFiles(folder, job.Id + ".*"))
            {
                File.Delete(file);
            }
        }
        catch (IOException ex)
        {
            // A download still reading it, on a system that will not delete an open file. The next
            // start of the server clears the folder anyway.
            log.LogWarning(ex, "Could not delete the output of script job {Id}", job.Id);
        }
    }

    // The same reading of errors the synchronous endpoints give: the message is the part a person
    // can act on, whether it is a timeout, a bad WHERE or a configuration problem.
    private static string Describe(Exception ex) => ex switch
    {
        CatalogTimeoutException timeout => timeout.Message,
        SqlException sql => sql.Message,
        InvalidOperationException invalid => invalid.Message,
        _ => "Script generation failed: " + ex.Message,
    };

    public void Dispose()
    {
        sweeper?.Dispose();
        foreach (var job in jobs.Values)
        {
            job.Cancellation.Cancel();
        }
    }
}
