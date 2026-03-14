# Option 4: Amplify DataStore (Most Luxurious)

**How it works:** Amplify DataStore is a client-side library that provides a local-first programming model. You define models, call `DataStore.save()` / `DataStore.query()`, and sync happens transparently. Under the hood it uses AppSync + DynamoDB with delta sync tables.

## Implementation sketch

1. Define data models using Amplify schema DSL
2. `amplify push` provisions AppSync API + DynamoDB tables + delta tables
3. Application code uses DataStore API (local reads/writes)
4. DataStore handles background sync, conflict resolution, offline queue

```typescript
// Writing data -- looks like a local operation
await DataStore.save(new Session({
  sessionId: 'abc-123',
  startTime: new Date().toISOString(),
  totalInputTokens: 15000,
  totalOutputTokens: 3200,
  totalCost: 0.42
}));

// Reading data -- also local-first
const sessions = await DataStore.query(Session, s =>
  s.startTime.gt('2026-03-01')
);
```

## Pros

- Minimal sync code (DataStore handles everything)
- True offline-first: app works fully offline, syncs when connected
- Built-in conflict resolution (auto-merge, optimistic concurrency, custom Lambda)
- Delta sync minimizes data transfer (only changed records)
- Client stores data in IndexedDB (web) or SQLite (mobile/native)

## Cons

- Amplify ecosystem buy-in (CLI, libraries, conventions)
- Debugging sync issues is a black box
- Heavier dependency footprint
- May conflict with existing SQLite store (would need migration or adapter)
- Amplify CLI manages infrastructure -- less control

## Cost

DataStore library is free. You pay for AppSync + DynamoDB underneath.

## Complexity

Low for developers, high under the hood. Fastest time-to-working-sync.

## Best for

When offline-first is non-negotiable and you want zero sync code.
