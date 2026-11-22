using System.Diagnostics;

namespace SqlMetadataGenerator.Scripting;

// Where a script job is, phase by phase, for a caller that wants to show it.
//
// A script over a large database spends minutes in a handful of reads, and from the outside that
// looked like nothing happening. Each phase here is one of those reads, or the writing that follows
// them, with a count where one exists ("batch 23 of 56") and the time it has taken so far.
//
// Several phases run at once (the catalog, the tables and the module headers are read side by
// side), and the readers report from worker threads. Every change goes through one lock, and a
// snapshot is a copy, so the caller reading it never sees a phase half updated.
public sealed class ScriptProgress
{
    public enum State
    {
        Waiting,
        Running,
        Done,
    }

    public sealed record Phase(
        string Key,
        string Title,
        State State,
        int Done,
        int? Total,
        string? Unit,
        string? Detail,
        double Seconds,
        IReadOnlyList<Step> Steps);

    // A part of a phase that runs on its own, like one of the seven queries behind the table read.
    // A phase that waits on its slowest part can then say which part that is.
    public sealed record Step(string Name, State State, double Seconds);

    private sealed class StepEntry(string name)
    {
        public string Name { get; } = name;
        public State State { get; set; } = State.Waiting;
        public Stopwatch Clock { get; } = new();
    }

    private sealed class Entry(string key, string title)
    {
        public string Key { get; } = key;
        public string Title { get; } = title;
        public State State { get; set; } = State.Waiting;
        public int Done { get; set; }
        public int? Total { get; set; }
        public string? Unit { get; set; }
        public string? Detail { get; set; }
        public Stopwatch Clock { get; } = new();
        public List<StepEntry> Steps { get; } = [];
    }

    private readonly Lock gate = new();
    private readonly List<Entry> entries = [];
    // Phases that come after everything else whenever they were added: the caller knows from the
    // start that it will write a file at the end, but the build's own phases are added later.
    private readonly List<Entry> tail = [];

    // Phases are listed in the order they are added, which is the order they are shown in.
    // Adding one that exists already is a no-op, so a caller can declare its phases up front.
    public void Add(string key, string title)
    {
        lock (gate)
        {
            if (Find(key) is null)
            {
                entries.Add(new Entry(key, title));
            }
        }
    }

    public void AddLast(string key, string title)
    {
        lock (gate)
        {
            if (Find(key) is null)
            {
                tail.Add(new Entry(key, title));
            }
        }
    }

    public void Start(string key, int? total = null, string? unit = null)
    {
        Change(key, e =>
        {
            e.State = State.Running;
            e.Total = total ?? e.Total;
            e.Unit = unit ?? e.Unit;
            e.Clock.Start();
        });
    }

    // The total is often known only once the phase is under way: how many definition batches
    // there are depends on the headers read before them.
    public void SetTotal(string key, int total, string unit) =>
        Change(key, e =>
        {
            e.Total = total;
            e.Unit = unit;
        });

    public void Advance(string key, int by = 1) => Change(key, e => e.Done += by);

    public void Describe(string key, string? detail) => Change(key, e => e.Detail = detail);

    public void Finish(string key, string? detail = null) =>
        Change(key, e =>
        {
            e.State = State.Done;
            e.Detail = detail;
            if (e.Total is { } total)
            {
                e.Done = total;
            }
            e.Clock.Stop();
        });

    // Lists a phase's steps up front, all waiting, so the whole set shows before any has started.
    public void AddSteps(string key, IEnumerable<string> names) =>
        Change(key, e =>
        {
            foreach (string name in names)
            {
                if (e.Steps.All(x => x.Name != name))
                {
                    e.Steps.Add(new StepEntry(name));
                }
            }
        });

    // A reader's step callback wired to one phase: false when a step starts, true when it ends.
    public Action<string, bool> Stepper(string key) =>
        (name, finished) => Change(key, e =>
        {
            var step = e.Steps.FirstOrDefault(x => x.Name == name);
            if (step is null)
            {
                step = new StepEntry(name);
                e.Steps.Add(step);
            }
            if (finished)
            {
                step.State = State.Done;
                step.Clock.Stop();
            }
            else
            {
                step.State = State.Running;
                step.Clock.Start();
            }
        });

    // A reader's IProgress<int> wired to one phase: each report advances it.
    public IProgress<int> Counter(string key) => new Reporter(this, key);

    public IReadOnlyList<Phase> Snapshot()
    {
        lock (gate)
        {
            return entries
                .Concat(tail)
                .Select(e => new Phase(
                    e.Key, e.Title, e.State, e.Done, e.Total, e.Unit, e.Detail, e.Clock.Elapsed.TotalSeconds,
                    e.Steps.Select(x => new Step(x.Name, x.State, x.Clock.Elapsed.TotalSeconds)).ToList()))
                .ToList();
        }
    }

    private void Change(string key, Action<Entry> change)
    {
        lock (gate)
        {
            if (Find(key) is { } entry)
            {
                change(entry);
            }
        }
    }

    private Entry? Find(string key) => entries.Concat(tail).FirstOrDefault(e => e.Key == key);

    // Progress<T> would post each report to a synchronization context, and there is none on a
    // background job. This one applies the report on the thread that made it.
    private sealed class Reporter(ScriptProgress owner, string key) : IProgress<int>
    {
        public void Report(int value) => owner.Advance(key, value);
    }
}
