# AGENTS.md

## Purpose

This file defines the working rules for all AI agents and developers contributing to SkyOS.

## General Rules

- Read this file before making changes.
- Do not implement undefined features.
- Prefer simple and maintainable solutions.
- Keep architecture modular.
- Avoid unnecessary dependencies.
- Never commit secrets or credentials.
- Update documentation when behavior changes.
- Keep changes focused and reviewable.

## Repository Rules

- Applications belong in apps.
- Backend services belong in services.
- Shared code belongs in packages.
- Infrastructure code belongs in infrastructure.
- Database schemas and migrations belong in database.
- Architecture decisions belong in architecture.
- General documentation belongs in docs.
- Automated tests belong close to the code or in tests.

## Code Quality

- Use strict type checking.
- Validate external input.
- Handle errors explicitly.
- Avoid duplicated logic.
- Use clear names.
- Add tests for important behavior.
- Do not leave broken builds.

## Security

- Never hardcode secrets.
- Use environment variables for local configuration.
- Apply least privilege.
- Validate permissions on protected operations.
- Do not log sensitive data.
- Treat all external input as untrusted.

## Git Workflow

- Work in small logical changes.
- Use descriptive commit messages.
- Do not rewrite unrelated code.
- Explain architectural changes.
- Keep the repository runnable after each completed task.

## AI Agent Behavior

Before implementation:

1. Inspect the repository.
2. Read relevant documentation.
3. Identify dependencies.
4. Propose a concise plan.
5. Implement only the requested scope.
6. Run relevant checks.
7. Summarize changes and remaining risks.

## Current Priority

Build the initial SkyOS MVP foundation.

Do not attempt to build the entire enterprise platform in one task.
