# BrainBuddy Memory Privacy

BrainBuddy preserves a user's original input while giving local search and AI a user-approved memory containing only the references the user chose to extract.

## Records

**Original Input（原始输入）**:
The complete text submitted by the user for either a write or a query.
_Avoid_: Keystroke log, autosaved draft

**Source Record（原始记录）**:
The preserved, private record of one user submission, including whether it was a write or query. Its Original Input is excluded from automatic AI context.
_Avoid_: Log, audit log, memory backup

**Memory（本地记忆）**:
A mutable local file that AI can read, create, and update through controlled operations. It may reference zero or more Source Records and Credentials.
_Avoid_: Database memory row, protected view, source record

**Credential（凭据）**:
A value extracted from a user submission and kept as a separately retrievable private record with links to its Source Records.
_Avoid_: Redaction, placeholder, source record

## Identity and References

**Source ID**:
The stable identity of one Source Record.
_Avoid_: Log ID, memory ID

**Memory Path**:
The controlled local path that locates a Memory file for reading or writing.
_Avoid_: Memory ID, arbitrary filesystem path

**Credential ID**:
The stable identity of one Credential.
_Avoid_: Secret value, credential label

**Source Reference（原始记录引用）**:
An AI-visible reference such as `[SOURCE:<id>]` that identifies a Source Record without exposing its Original Input.
_Avoid_: Decrypted source, log content

**Credential Reference（凭据引用）**:
An AI-visible reference such as `[CREDENTIAL:<id>]` that identifies a Credential without exposing its value.
_Avoid_: Masked secret, credential value

**Credential Source Link（凭据来源关系）**:
The provenance relationship connecting one Credential to every Source Record in which it was extracted or observed.
_Avoid_: Credential Reference, embedded Source ID

## User Decisions

**Keep Original（保留原文）**:
A protection decision that leaves the detected value in Memory, where it is also visible to AI.
_Avoid_: Local-only, automatically redacted

**Extract as Credential（抽离为凭据）**:
A protection decision that moves the detected value into a Credential and leaves its Credential Reference in Memory.
_Avoid_: Delete, generic masking

**Source Reveal（查看原始记录）**:
An explicit user action that retrieves and temporarily displays the Original Input of a Source Record.
_Avoid_: Automatic restoration, AI lookup
