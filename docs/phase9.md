# What Was Built and Proven — Authentication, API Keys, and Multi-Tenancy

This phase moved the system from a single-user or loosely isolated architecture toward a proper **multi-tenant platform**.

The main goal was to ensure that:

* Different users can own their own functions.
* Users cannot access each other's resources.
* Humans and machines can authenticate differently.
* API keys can have restricted access.
* Resource ownership is enforced consistently.
* Tests can run independently without data collisions.

The result was verified with:

```text
28 / 28 tests passed
Run 1 → 28 / 28
Run 2 → 28 / 28
```

In addition to automated testing, the system was demonstrated live using two separate users, **Alice** and **Bob**, to prove that cross-tenant access was correctly blocked.

---

# 1. Adding Real User Ownership to the System

Previously, a function could exist without being clearly tied to a specific user.

This creates a problem in a multi-user system.

For example:

```text
Functions

Function A
Function B
Function C
```

But the system needs to know:

```text
Who owns Function A?
Who owns Function B?
Who is allowed to invoke Function C?
```

To solve this, the schema was expanded with two important entities:

```text
User
ApiKey
```

The `Function` entity also gained a `userId`.

Conceptually:

```text
User
 │
 ├── Function A
 ├── Function B
 │
 └── API Keys
```

Each function now belongs to a specific user.

For example:

```text
Alice
 ├── weather-api
 └── image-processor

Bob
 ├── payment-api
 └── notification-service
```

This establishes a proper ownership boundary.

---

# 2. The Unique Constraint Was Changed for Multi-Tenancy

Previously, the system may have enforced something like:

```text
Function.name must be globally unique
```

That means:

```text
Alice → "hello-world" ✅
Bob   → "hello-world" ❌
```

This is not desirable in a multi-user platform.

Two different users should be allowed to create functions with the same name because they belong to different namespaces.

Therefore, the unique constraint was changed from:

```text
(name)
```

to:

```text
(userId, name)
```

This means the combination of:

```text
User ID + Function Name
```

must be unique.

For example:

```text
Alice + "hello-world" → Allowed
Bob   + "hello-world" → Allowed

Alice + "hello-world" → Duplicate ❌
```

Conceptually:

```text
Functions

┌──────────┬───────────────┐
│ User     │ Function Name │
├──────────┼───────────────┤
│ Alice    │ hello-world   │
│ Bob      │ hello-world   │
│ Alice    │ image-resize  │
│ Bob      │ image-resize  │
└──────────┴───────────────┘
```

This is the correct database model for a multi-tenant application.

An important point is that this was not a new idea invented during this phase. The exact solution had already been discussed in the Phase 4 interview answers. This phase turned that architectural reasoning into an actual implementation.

---

# 3. Two Different Credential Types Behind One Authentication Guard

The system now supports two types of authentication:

1. **JWT tokens for humans**
2. **API keys for machines**

Both use the same HTTP header:

```http
Authorization: Bearer <credential>
```

For example, a human user might send:

```http
Authorization: Bearer eyJhbGciOi...
```

A machine using an API key might send:

```http
Authorization: Bearer mc_abc123xyz...
```

The system determines which authentication mechanism to use by checking the credential.

The `mc_` prefix identifies an API key.

Conceptually:

```text
Authorization: Bearer <credential>
                 |
                 v
          Starts with mc_?
                 |
          +------+------+
          |             |
         Yes            No
          |             |
          v             v
       API Key          JWT
          |             |
          +------+
                 |
                 v
         Authentication Guard
```

This allows the application to expose a simple and consistent authentication interface while supporting different credential types internally.

---

# 4. JWT Is for Humans

A JWT represents a logged-in user.

For example:

```text
Human User
    |
    v
Login
    |
    v
JWT Generated
    |
    v
Access Platform
```

The important design decision is that a JWT gives the actual account owner **full access to their own resources**.

For example:

```text
Alice logs in
     |
     v
JWT identifies Alice
     |
     v
Alice can access all functions owned by Alice
```

The system does not unnecessarily restrict the account owner based on the permissions of one of their API keys.

This leads to an important principle.

> **API key permissions restrict the delegated credential, not the account owner.**

For example:

```text
Alice
 ├── Owns Function A
 ├── Owns Function B
 └── Owns Function C

Alice's API Key
 └── Allowed only for Function A
```

The API key is restricted:

```text
API Key → Function A only
```

But Alice herself, using JWT authentication, still has access to:

```text
JWT → Function A
JWT → Function B
JWT → Function C
```

This is important because an API key represents delegated access, while a JWT represents the authenticated account owner.

---

# 5. API Keys Are for Machines

API keys allow applications, services, scripts, or external systems to authenticate without requiring an interactive human login.

For example:

```text
External Application
        |
        | API Key
        v
    Platform
```

An API key may be intentionally restricted.

For example:

```text
Machine API Key
       |
       +--> Can invoke Function A
       |
       +--> Cannot access Function B
       |
       +--> Cannot access Function C
```

This follows the principle of **least privilege**.

A machine should receive only the permissions it actually needs.

---

# 6. Why Both Credentials Use the Same Header

Both JWTs and API keys are sent through:

```http
Authorization: Bearer <credential>
```

This provides a clean API design.

Clients do not need separate headers such as:

```http
X-API-Key: ...
Authorization: ...
```

Instead, the authentication guard can inspect the credential:

```text
Bearer Credential
       |
       v
Starts with "mc_"?
       |
   +---+---+
   |       |
  Yes      No
   |       |
API Key   JWT
```

The client interface remains simple while the backend handles the authentication differences.

---

# 7. Why API Keys Use SHA-256 Instead of bcrypt

One of the most important technical decisions in this phase is the difference between hashing API keys and hashing passwords.

At first, it may seem that both should use the same hashing algorithm.

However, they solve very different security problems.

---

## Password Hashing

Passwords are chosen by humans.

Humans often choose weak or predictable passwords:

```text
password123
12345678
myname123
```

An attacker who steals password hashes can try many guesses.

Therefore, password hashing should deliberately be slow.

bcrypt is designed for this purpose:

```text
Guess Password
      |
      v
Slow Hashing Process
      |
      v
Compare Hash
```

If every guess is slow, an attacker can make fewer guesses per second.

Therefore:

> **The security of password hashing partly depends on making guessing expensive and slow.**

---

## API Key Hashing

API keys are different.

A secure API key should be a long, randomly generated secret:

```text
mc_a8f93k29d7x...very-long-random-value
```

The system receives the key and needs to find the corresponding database record.

This happens on the authentication path:

```text
Incoming Request
       |
       v
Receive API Key
       |
       v
Hash Key
       |
       v
Database Lookup
       |
       v
Authenticate
```

This is a frequent operation.

The application needs a deterministic value that can be indexed and searched efficiently.

Therefore:

```text
SHA-256(API Key)
        |
        v
Indexed Database Lookup
```

Using bcrypt would make the lookup difficult and inefficient because bcrypt hashes are intentionally slow and normally require checking candidate records individually rather than performing a direct indexed lookup.

The key difference is:

```text
Password
    ↓
Human-chosen secret
    ↓
Main threat = guessing attacks
    ↓
Hashing should be slow
    ↓
bcrypt
```

Compared with:

```text
API Key
    ↓
High-entropy random secret
    ↓
Need fast deterministic lookup
    ↓
Hashing should be fast
    ↓
SHA-256
```

Therefore:

> **Passwords use slow hashing because being slow is part of their defense. API keys use fast SHA-256 because authentication requires efficient indexed lookup.**

This is a non-obvious but important distinction.

---

# 8. A Real Security Bug Was Discovered During the Retrofit

During the multi-tenancy implementation, a genuine authorization bug was discovered.

This was not a hypothetical security issue.

The existing `BuildController.getBuild` endpoint checked whether the user owned the function.

For example:

```text
User requests:

GET /functions/my-function/builds/build-123
```

The controller verified:

```text
Does this user own "my-function"?
```

However, it did not verify:

```text
Does "build-123" actually belong to "my-function"?
```

This created an authorization gap.

---

# 9. How the Security Bug Could Happen

Imagine:

```text
Alice
 └── Function: secret-function
       └── Build ID: build-999
```

Bob owns his own function:

```text
Bob
 └── Function: bob-function
```

Bob could make a request such as:

```text
GET /functions/bob-function/builds/build-999
```

The system would verify:

```text
Does Bob own "bob-function"?

Yes ✅
```

But if it only searched for:

```text
Build ID = build-999
```

without verifying the relationship:

```text
Build.functionId = bob-function
```

then the system could potentially return Alice's build.

Conceptually, the old logic was:

```text
User owns Function?
        |
       Yes
        |
        v
Find Build by buildId
        |
        v
Return Build
```

The missing validation was:

```text
Does the requested build belong to the requested function?
```

This could allow an authenticated user to read another user's build error messages simply by guessing or obtaining a valid build ID.

---

# 10. The Correct Fix

The lookup must enforce the full ownership chain.

Instead of:

```text
User → Owns Function

Build → Found by ID
```

the system must verify:

```text
User
 |
 v
Owns Function
 |
 v
Function Owns Build
```

Conceptually:

```text
Requested User
       |
       v
Requested Function
       |
       v
Requested Build
```

All relationships must match.

The query logic effectively becomes:

```text
Find Build where:

build.id = requestedBuildId

AND

build.function = requestedFunction

AND

function.userId = authenticatedUser
```

This closes the authorization gap.

The important lesson is:

> **Checking ownership at one level of a resource hierarchy is not enough. Every relationship in the access path must be verified.**

---

# 11. Live Cross-Tenant Security Proof

The security behavior was demonstrated live using two separate users:

```text
Alice
Bob
```

Alice owns a function:

```text
Alice
 └── secret-function
```

Bob attempts to access Alice's function.

Two operations were tested.

### Attempt 1: GET the Function

```text
Bob
 |
 v
GET Alice's Function
 |
 v
404 Not Found
```

### Attempt 2: Invoke the Function

```text
Bob
 |
 v
Invoke Alice's Function
 |
 v
404 Not Found
```

Both operations returned exactly the same result:

```http
404 Not Found
```

---

# 12. Why Returning 404 Is Important

It might seem more logical to return:

```http
403 Forbidden
```

However, that response reveals something important.

Consider these two responses:

```text
Function does not exist
→ 404
```

and:

```text
Function exists, but you cannot access it
→ 403
```

An attacker could use this difference to discover which functions exist.

For example:

```text
Try function-a → 404
Try secret-api  → 403
Try function-b → 404
```

The attacker has now learned:

```text
secret-api exists
```

Even though they were not allowed to access it.

This is known as an information disclosure problem.

The correct behavior is:

```text
Doesn't exist
       ↓
404

Exists but belongs to someone else
       ↓
404
```

From Bob's perspective:

```text
Alice's function does not exist.
```

Whether it truly does not exist or Bob simply lacks access is intentionally hidden.

This prevents the system from leaking resource existence across tenants.

---

# 13. Why GET and Invoke Both Returning 404 Matters

The live test demonstrated:

```text
Bob → GET Alice's Function → 404
Bob → Invoke Alice's Function → 404
```

The behavior is identical.

This is important because security must be consistent across all access paths.

It is not enough to protect one endpoint:

```text
GET → Protected
```

while forgetting another:

```text
INVOKE → Vulnerable
```

The live demo proved that both read access and function execution respect the tenant boundary.

---

# 14. Multi-Tenancy Simplified the Test Suite

An interesting side effect of multi-tenancy was that the test suite became simpler.

Previously, tests may have needed to manually remove old data:

```javascript
beforeEach(async () => {
    await database.function.deleteMany();
});
```

This was necessary because multiple tests could create functions with the same names.

For example:

```text
Test A → creates "hello"
Test B → creates "hello"
```

Without cleanup:

```text
Unique constraint error
```

With user-scoped functions, every test can create its own unique user.

For example:

```text
Test A
User: test-a-random@email.com
Function: hello
```

```text
Test B
User: test-b-random@email.com
Function: hello
```

The same function name can now exist because the users are different.

The uniqueness boundary is:

```text
(userId, name)
```

rather than:

```text
(name)
```

Therefore, test data naturally becomes isolated.

---

# 15. Why Random Emails Help Test Isolation

Each test file can generate a unique user:

```text
test-8f29@email.com
test-k29x@email.com
test-p3ab@email.com
```

Then all resources belong to that user.

Conceptually:

```text
Test File A
 └── Random User A
      └── Test Functions

Test File B
 └── Random User B
      └── Test Functions
```

These tests cannot accidentally access or conflict with each other's data.

This removes the need for repeated global cleanup such as:

```text
deleteMany()
```

between tests.

The result is:

* Better isolation.
* Fewer accidental collisions.
* Less cleanup code.
* Safer parallel testing.
* More realistic multi-user test scenarios.

An interesting architectural result is:

> **Adding proper ownership boundaries improved both production security and test isolation.**

---

# 16. Overall Architecture

After this phase, the ownership and authentication flow looks conceptually like this:

```text
                    Incoming Request
                           |
                           v
             Authorization: Bearer <credential>
                           |
                    +------+------+
                    |             |
              Starts with mc_?    JWT
                    |             |
                   Yes            No
                    |             |
                    v             v
                 API Key       Logged-in User
                    |             |
                    v             v
              Scoped Access    Full Owner Access
                    |             |
                    +------+------+
                           |
                           v
                    Authentication
                           |
                           v
                    Authorization
                           |
                           v
                    Check Ownership
                           |
                           v
                     Access Resource
```

For resource relationships:

```text
User
 |
 +--------------------+
 |                    |
 v                    v
Function            API Key
 |
 v
Build
```

Access must respect the ownership hierarchy:

```text
Authenticated Identity
        |
        v
User / API Key Scope
        |
        v
Function Ownership
        |
        v
Build Ownership
```

---

# 17. What Was Proven

The implementation was verified through both automated tests and a live cross-tenant demonstration.

## Automated Tests

The complete test suite passed twice:

```text
First Clean Run  → 28 / 28 Passed
Second Clean Run → 28 / 28 Passed
```

This gives stronger confidence that the implementation is deterministic rather than passing only because of leftover data or timing conditions.

---

## Live Security Proof

Using two separate users:

```text
Alice → Owns a function
Bob   → Attempts to access it
```

Bob received:

```http
404 Not Found
```

for both:

```text
GET
```

and:

```text
Invoke
```

This demonstrated that cross-tenant resource access was blocked and that the system did not reveal whether Alice's function actually existed.

---

# 18. Final Outcome

This phase delivered several important improvements.

## Real Multi-Tenancy

Functions are now owned by users:

```text
Function → userId
```

and names are unique only within a user's namespace:

```text
(userId, name)
```

---

## Human and Machine Authentication

The system supports:

```text
JWT      → Humans / Account Owners
API Keys → Machines / Delegated Access
```

through a single authentication guard.

---

## Correct Permission Model

The account owner is not restricted by the permissions of their API keys.

Instead:

```text
Owner JWT
    ↓
Full access to owner's resources
```

while:

```text
API Key
    ↓
Only delegated and scoped permissions
```

---

## Efficient API Key Authentication

API keys use SHA-256 because authentication requires a fast, deterministic, indexed lookup.

Passwords use bcrypt because the purpose of password hashing is to make guessing deliberately slow.

```text
Password → Slow bcrypt
API Key  → Fast SHA-256 lookup
```

---

## A Real Authorization Vulnerability Was Fixed

The system previously verified ownership of a function without fully verifying that the requested build belonged to that function.

The fix enforced the complete relationship:

```text
User
 ↓
Function
 ↓
Build
```

This prevented authenticated users from accessing build information belonging to another user's resources.

---

## Cross-Tenant Access Was Proven Live

Bob's attempts to:

```text
GET Alice's function
Invoke Alice's function
```

both returned:

```http
404 Not Found
```

This correctly hides whether the resource exists and prevents information leakage.

---

## Testing Became Simpler

Proper multi-tenancy naturally isolated test data.

Instead of manually deleting data between tests:

```text
deleteMany()
```

each test can use its own randomly generated user.

Therefore:

```text
Different User
    +
Same Function Name
    =
No Collision
```

---

# Key Architectural Insight

The biggest result of this phase is that **multi-tenancy was not just a database change**.

Adding `userId` to `Function` affected the entire system:

```text
Database Schema
       ↓
Authentication
       ↓
Authorization
       ↓
API Key Scoping
       ↓
Resource Ownership
       ↓
Build Access
       ↓
Cross-Tenant Security
       ↓
Test Isolation
```

The implementation therefore established a real ownership model across the platform.

The core principle can be summarized as:

> **Authentication answers "Who are you?" Authorization answers "What are you allowed to access?" In a multi-tenant system, every resource lookup must enforce that boundary through the complete ownership chain.**

This phase proved that the system now supports separate users, scoped machine credentials, protected resources, secure cross-tenant behavior, and isolated testing — with **28/28 tests passing across two clean full-suite runs and a live cross-tenant demonstration confirming that unauthorized resources are indistinguishable from resources that do not exist.**
