<p align="center">
  <img src="SqlMetadataGeneratorLogo.png" alt="SqlMetadataGenerator" width="200">
</p>

# SqlMetadataGenerator

A .NET 10 toolkit for SQL Server:

- **CLI:** export database object definitions into an SSMS-like folder tree and apply those scripts to an existing target database.
- **Web explorer:** browse servers, databases and objects through an ASP.NET Core API and a React + TypeScript interface.

Script generation exports object definitions, not table data; it is not a database backup.

## Web explorer features

- **Server overview:** choose among configured connections and inspect SQL Server version, edition and collation. The database list shows allocated data/log file sizes, state, recovery model and creation date, with sortable columns.
- **Database dashboard:** follow object-count links to tables, views, procedures, functions, triggers, synonyms, sequences, types and schemas. An interactive treemap shows allocated table space by area and approximate row counts by color; click a schema to drill in or a table to open it. A largest-tables list helps identify where space is allocated. Dashboard row counts come from catalog metadata without scanning the tables.
- **Searchable object lists:** search tables and other objects by name or schema, sort the lists, and filter tables to a specific schema.
- **Table details:** inspect column types, nullability, primary-key order, identity/computed flags and defaults. Review indexes, key and included columns, uniqueness and filter expressions, alongside the table's owner and creation/modification dates when available.
- **Data preview and SQL queries:** opening a table loads a 20-row preview and its SQL into a Monaco editor. Edit and execute a single `SELECT` query, view results, elapsed time and server messages, or cancel a running request. The UI caps query results at 1,000 rows. Use **F5** or **Alt+X** to execute and **Esc** to cancel; drag the divider to resize the editor and results panes.
- **Result selection and copying:** select cells, rows or columns in the result grid and copy them as plain text or spreadsheet-compatible HTML.
- **SQL definitions and scripts:** view a table's generated SQL script, stored definitions for views and SQL modules, and generated definitions for supported objects such as synonyms, sequences and user-defined types.
- **Direct navigation:** breadcrumb navigation and bookmarkable URLs let you return directly to a server, database, object list or detail page.

For example, `/app/demo/MyDb` opens a database dashboard and
`/app/demo/MyDb/tables/dbo/Customers` opens a table. The `demo` segment is the connection alias from `connections.json`.
The explorer reads live SQL Server metadata and data; it does not require a previous CLI export.

## Project layout

```
src/SqlMetadataGenerator.Core/   metadata reading, scripting and deploy logic (class library)
src/SqlMetadataGenerator.Cli/    the console app
src/SqlMetadataGenerator.Web/    ASP.NET Core API and built frontend host
viewer/web/                     React + TypeScript frontend (Vite)
connections.example.json        example web connection configuration
```

## Requirements

- .NET 10 **SDK** (all .NET projects target `net10.0`).
- Node.js and npm for the web frontend. The locked tooling requires Node.js `^20.19.0 || >=22.12.0`.
- Access to SQL Server with permission to read the required metadata and object definitions. Deploy additionally requires permission to execute the generated DDL in the target database.

The commands below use **PowerShell** and start in the repository root unless stated otherwise.
Replace example server names, database names, users and passwords with your own values.

Check the tools are available:

```powershell
dotnet --list-sdks
node --version
npm --version
```

Node.js and npm are only needed for the frontend. `dotnet run` restores NuGet packages and builds the selected project automatically.

## Run the web explorer

### 1. Configure connections

If you do not already have `connections.json`, copy the template at the repository root:

```powershell
Copy-Item connections.example.json connections.json
```

Edit `connections.json`:

- For the `demo` entry, set `server` (for example `localhost,1433`) and `user`. Its `auth: "sql"` uses the password from the environment variable named by `passwordEnv`, which is `SQLMETA_PW_DEMO` in the template.
- For Windows authentication, use the `local` entry with `auth: "integrated"` and set its `server`. It uses the identity running the API and needs no password variable.
- Remove example entries you do not need. Each `alias` must be unique and use ASCII letters, digits, `-` or `_`, starting with a letter or digit.

Local `connections*.json` files are ignored by Git; `connections.example.json` is the tracked template.
The API loads the connection registry at startup, so restart it after editing the file.
This configuration is for the web application; the CLI takes connection options as arguments.

### 2. Start the API

In the first terminal, set the SQL password and start the API in the same PowerShell session:

```powershell
$env:SQLMETA_PW_DEMO = 'YOUR_SQL_PASSWORD'
dotnet run --project src/SqlMetadataGenerator.Web
```

Skip the environment-variable command if you only use integrated authentication.
In Bash, the equivalent is `export SQLMETA_PW_DEMO='YOUR_SQL_PASSWORD'`.
The application does not automatically load a `.env` file.

The included launch profile starts the API at `http://localhost:5099`.
Open `http://localhost:5099/api/health` to check that it is running; this endpoint does not test SQL Server connectivity.

The host searches for `connections.json` in the working directory, content root and parent directories.
To select another file, pass its absolute path:

```powershell
dotnet run --project src/SqlMetadataGenerator.Web -- --ConnectionsFile "C:\config\connections.local.json"
```

### 3. Start the frontend

In a second terminal, starting at the repository root:

```powershell
cd viewer/web
npm ci
npm run dev
```

Open **http://localhost:5173/app**. Vite proxies `/api` requests to `http://localhost:5099`.
Choose a connection, then a database to explore its objects.

### Serve the built frontend from ASP.NET Core

To run the UI and API on one port without the Vite development server, build the frontend first.
Starting at the repository root:

```powershell
cd viewer/web
npm ci
npm run build
cd ../..
dotnet run --project src/SqlMetadataGenerator.Web
```

Set any required password variables in this terminal before starting the API.
The frontend build writes to `src/SqlMetadataGenerator.Web/wwwroot/`; ASP.NET Core serves it at
**http://localhost:5099/app**. Rebuild the frontend after changing its source.
If publishing the web project with `dotnet publish`, run the frontend build first so those assets are included.

## CLI usage

Generate scripts:

```powershell
dotnet run --project src/SqlMetadataGenerator.Cli -- --server "localhost,1433" --database MyDb --user readonlyuser --password 'YOUR_SQL_PASSWORD' --output ./output
```

With Windows authentication:

```powershell
dotnet run --project src/SqlMetadataGenerator.Cli -- --server localhost --database MyDb --integrated
```

Deploy the generated files to an **existing** target database. Create `MyDbCopy` first;
the application connects to it before executing any scripts. The source below matches the Windows authentication example:

```powershell
dotnet run --project src/SqlMetadataGenerator.Cli -- --server localhost --database MyDbCopy --integrated --deploy --source ./output/localhost/MyDb
```

Use the actual output directory printed by the export command as `--source`.
Deploy executes the SQL files against the target; it is not a schema-diff migration tool or an all-or-nothing transaction.

Run with no arguments to see the full option list:

```powershell
dotnet run --project src/SqlMetadataGenerator.Cli
```

## Output layout

```
{output}/{server}/{database}/
  Tables/{schema}/{schema}.{name}.sql
  Views/{schema}/...
  Synonyms/{schema}/...
  Security/Schemas/{name}.sql
  Programmability/
    Stored Procedures/ | Functions/ | Sequences/ | Types/
  _snapshot.json
```

## Behaviour

- **Incremental** — when `_snapshot.json` exists, only modules whose `modify_date` changed are
  re-read; other included metadata is read again. `--full` forces a full read.
  Files tracked in the previous snapshot but absent from the new selection are deleted, including objects removed by changed exclusion filters.
- **Exclusions** — `--exclude` accepts comma-separated object types: `schemas,sequences,types,tables,views,procedures,functions,triggers,synonyms`.
  `--exclude-schema` excludes schemas and `--exclude-name` excludes objects whose names contain the supplied text; both accept comma-separated lists.
- **Formatting** — `--keyword-case lower|upper`, `--set-options`, `--no-group-columns`,
  `--audit-columns` (audit columns are separated by a blank line at the end of the column list).
- **Deploy** — dependency order is unknown, so batches are applied in multiple retry rounds;
  batches that never succeed are reported as errors (exit code 4).

## Troubleshooting

- **`dotnet`, `node` or `npm` is not recognized:** install the required tools or fix `PATH`, then reopen the terminal.
- **Empty web connection list:** check that `connections.json` exists. The API startup log reports the file it loaded or warns that none was found.
- **`No password for ...`:** set the environment variable named by that connection's `passwordEnv` in the terminal that starts the API, then restart it.
- **Frontend cannot reach the API:** ensure the API is running on port `5099`. If you change that port, update the proxy target in `viewer/web/vite.config.ts` too.
- **No UI on port `5099`:** use the Vite URL during development, or run `npm run build` to create the files served by ASP.NET Core.
- **SQL connection fails:** check the server/instance or port, authentication mode and database permissions.
