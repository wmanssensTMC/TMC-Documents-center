# TMC Document Center: how it is built

Version 20/10/2026 · Owner: Willem Manssens (AI lead, Transmare Chemie NV) · For: Cheops (IT), Jeroen

## In one sentence

One web application where TMC staff find, make and approve TMC versions of supplier documents (COA, MSDS, TDS, later labels). A separate engine rewrites supplier documents in the TMC layout; a person always approves before anything is Final.

## The parts

| Part | What it does | Pilot (now) | Azure (later) |
|---|---|---|---|
| Website | Library, upload, check screen, settings | Vercel | Azure App Service |
| Database | Documents, versions, audit trail, jobs, feedback | Neon (PostgreSQL, EU) | Azure Database for PostgreSQL |
| File storage | Supplier originals, TMC Word and PDF files | Vercel Blob (private, EU) | Azure Blob Storage (private) |
| Engine ("worker") | Reads the supplier document, makes the TMC draft | Docker image, Railway | Same Docker image, Azure Container Apps |
| Login | Who may enter, with which role | Password (pilot only) | Microsoft login (Entra), one app registration and one group |

The website only talks to small connectors for storage, login and the job queue. Moving to Azure is a change of settings, not a rebuild. The worker is one Docker image: the same image runs on Railway, on Azure or on a server in the office.

## How a document is processed

```
Person uploads a supplier PDF
  -> the website stores it and puts a job in the queue
  -> a worker takes the job (several workers can run side by side)
  -> DISPATCHER picks the engine: COA, MSDS or TDS (later: labels)
       either the type the person chose, or "auto": read from the document's title
  -> the engine makes a TMC Word draft
  -> PROVENANCE GATE: every value must be traceable to the supplier original,
     otherwise nothing is written
  -> anything uncertain is marked yellow; the PDF waits
  -> a person checks it on screen (original left, TMC version right),
     corrects or confirms, and approves
  -> Final: Word and PDF in the library, older version kept as Superseded
```

## Rules that never change

1. Nothing is invented: the provenance gate runs on every engine output.
2. Yellow (uncertain) parts never become Final without a person.
3. No supplier identity on any TMC output; the supplier name is internal information only.
4. Nothing is overwritten: a new version is made, the old one is kept as Superseded.
5. File names follow one fixed rule; every value in a file name is printed in the document.

## Why the engine runs separately

The engine needs LibreOffice (to make PDFs), Tesseract (to read scans) and Ghostscript, and one document can take several minutes. Web hosting such as Vercel or Azure App Service does not offer those programs and stops long requests, so the engine runs as its own container that takes jobs from the queue.

## Where AI fits in later

AI is a helper inside the same chain, never the one who decides:

- **Unknown document type:** AI suggests the type, a person confirms.
- **Difficult layouts and scans:** AI reads the table and proposes values; the provenance gate still checks every value against the supplier original, so AI cannot add anything that is not in it.
- **Check screen:** AI proposes a value for each yellow part; the person accepts or changes it.
- **Learning:** the feedback overview stores every correction people make; that is the material to improve the rules and the AI.
- **Which AI:** a model running inside TMC's own Azure tenant in an EU region (Azure OpenAI, or Claude through Microsoft Foundry), behind its own small connector so the AI supplier can be changed without a rebuild. Documents do not leave TMC.

## Data and security

- Pilot: test documents only, until Jeroen decides on real documents.
- Files are private: every download goes through the website, is checked against the login and written to the audit trail.
- Uploaded Word files are checked before processing (no macros, no outside links, no supplier name).
- Every step (upload, approval, rejection, download) is in an audit trail that cannot be edited.

## What we need from IT (Cheops)

1. **Now:** an Entra app registration "TMC Document Center" with a pilot group (request sent separately).
2. **For real documents:** an Azure subscription or resource group for the website, the database, file storage and the worker container, in an EU region.
3. **Optional, later:** access to an AI model inside TMC's Azure (Azure OpenAI or Microsoft Foundry).
