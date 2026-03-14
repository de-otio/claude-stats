# Option 3: AppSync + GraphQL (Full-Featured)

**How it works:** AWS AppSync provides a managed GraphQL API with real-time subscriptions over WebSockets. Clients mutate data; other devices receive updates instantly via subscriptions. AppSync resolvers connect to DynamoDB as the data store.

## Implementation sketch

1. Define GraphQL schema for sessions, messages, tags
2. AppSync resolvers map to DynamoDB tables
3. Client uses AppSync SDK with offline mutations + cache
4. Subscriptions push updates to connected devices in real-time

## Pros

- Real-time sync via WebSocket subscriptions
- Built-in offline support (AppSync SDK queues mutations)
- Three conflict resolution strategies: auto-merge, optimistic concurrency, custom Lambda
- Flexible querying via GraphQL

## Cons

- GraphQL learning curve
- More moving parts (schema, resolvers, DynamoDB, IAM)
- Higher per-operation cost than raw DynamoDB
- Debugging resolver issues can be painful

## Cost

$4/M query operations, $2/M real-time updates. Free tier for new accounts.

## Complexity

Medium-High. Schema + resolvers + client integration.

## Best for

When you want managed real-time sync with conflict resolution out of the box.
