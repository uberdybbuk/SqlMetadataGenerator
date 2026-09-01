<p align="center">
  <img src="SqlMetadataGeneratorLogo.png" alt="SqlMetadataGenerator" width="200">
</p>

# SqlMetadataGenerator

A .NET 10 console app that scripts a SQL Server database into an SSMS-like folder tree, and
recreates a database from those scripts.

## Project layout

```
src/SqlMetadataGenerator.Core/   metadata reading, scripting and deploy logic (class library)
src/SqlMetadataGenerator.Cli/    the console app
src/SqlMetadataGenerator.Web/    ASP.NET Core host (early scaffolding)
```

## Usage

Generate scripts:

```
dotnet run --project src/SqlMetadataGenerator.Cli -- --server localhost,1433 --database MyDb --user sa --password *** --output ./output
```

With Windows authentication:

```
dotnet run --project src/SqlMetadataGenerator.Cli -- --server localhost --database MyDb --integrated
```

Deploy the generated files to a target database:

```
dotnet run --project src/SqlMetadataGenerator.Cli -- --server localhost --database MyDbCopy --integrated --deploy --source ./output/localhost/MyDb
```

Run with no arguments to see the full option list.

## Output layout

```
{output}/{server}/{database}/
  Tables/{schema}/{schema}.{name}.sql
  Views/{schema}/...
  Synonyms/{schema}/...
  Programmability/
    Stored Procedures/ | Functions/ | Sequences/ | Types/
  _snapshot.json
```

## Behaviour

- **Incremental** — when `_snapshot.json` exists, only modules whose `modify_date` changed are
  re-read, and files for objects dropped from the database are deleted. `--full` forces a full read.
- **Exclusions** — `--exclude` (object type), `--exclude-schema`, `--exclude-name`.
- **Formatting** — `--keyword-case lower|upper`, `--set-options`, `--no-group-columns`,
  `--audit-columns` (audit columns are separated by a blank line at the end of the column list).
- **Deploy** — dependency order is unknown, so batches are applied in multiple retry rounds;
  batches that never succeed are reported as errors (exit code 4).

## Requirements

- .NET 10 SDK
- A SQL Server login that can read the `sys` catalog views
