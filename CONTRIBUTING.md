# Contributing to podscan

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Clone the repository:

```bash
git clone https://github.com/podscan/podscan-node.git
cd podscan-node
```

2. Install dependencies:

```bash
npm install
```

3. Run the test suite:

```bash
npm test
```

## Available Scripts

| Command | Description |
|---|---|
| `npm test` | Run the full test suite |
| `npm run build` | Build ESM + CJS output to `dist/` |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm run format` | Format source files with Prettier |

## Project Structure

```
src/
  index.ts              Barrel export
  client.ts             PodscanClient class
  http.ts               HTTP layer (native fetch wrapper)
  types.ts              All TypeScript interfaces
  resources/
    episodes.ts         Episodes endpoints
    podcasts.ts         Podcasts endpoints
    alerts.ts           Alerts endpoints
    topics.ts           Topics endpoints
    entities.ts         Entities endpoints
    lists.ts            Lists endpoints
    charts.ts           Charts endpoints
    publishers.ts       Publishers endpoints
test/
  helpers.ts            Shared fetch mock utilities
  http.test.ts          HTTP layer tests
  resources.test.ts     Resource module tests
  client.test.ts        Client integration tests
```

## Making Changes

1. Create a branch from `main`:

```bash
git checkout -b feature/your-feature
```

2. Make your changes.

3. Ensure all checks pass:

```bash
npm run lint
npm run typecheck
npm test
```

4. Commit your changes with a descriptive message.

5. Open a pull request against `main`.

## Guidelines

- **Zero runtime dependencies.** This package must not add any production dependencies. The SDK uses native `fetch` (Node 18+).
- **Type everything.** All public APIs must have full TypeScript types. Add param and response types to `src/types.ts`.
- **Test everything.** Every new endpoint or behavior needs a corresponding test using the Node.js built-in test runner (`node:test`).
- **Follow the existing patterns.** Each resource module follows the same structure. When adding a new endpoint, follow the pattern in existing resources.
- **Run Prettier.** All code must be formatted with Prettier before committing. Run `npm run format` to auto-format.

## Adding a New API Endpoint

1. Add the request params and response interfaces to `src/types.ts`.
2. Add the method to the appropriate resource in `src/resources/`.
3. Export any new types from `src/index.ts`.
4. Add tests in `test/resources.test.ts`.
5. Update the API reference table in `README.md`.

## Reporting Issues

If you find a bug or have a feature request, please [open an issue](https://github.com/podscan/podscan-node/issues) with:

- A clear description of the problem or suggestion
- Steps to reproduce (for bugs)
- Your Node.js version and OS
