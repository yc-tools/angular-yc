# @yc-tools/angular-yc-runtime

Runtime adapters for Angular SSR on Yandex Cloud Functions. Used by
[`@yc-tools/angular-yc`](https://github.com/yc-tools/angular-yc), which bundles
these handlers into the deployed server and image-optimizer functions.

## Server handler

`createServerHandler(options)` wraps the Angular SSR server (AngularAppEngine
or an Express app) as a Yandex Cloud Function handler.

### Logging

Each request produces exactly one summary log line:

```
[Server] GET /some/path 200 42ms
```

All other diagnostics (module resolution, engine calls, per-chunk writes) are
emitted only when `AYC_DEBUG` is set to a non-empty value.

### Handler timeout

If the underlying server handler neither ends the response nor raises an
error, the runtime rejects the invocation with a diagnostic error after a
safety timeout instead of hanging until the function times out silently.

- `AYC_HANDLER_TIMEOUT_MS` — timeout in milliseconds. Default: `55000`
  (slightly under the typical 60s function timeout). Set it below your
  function's configured timeout.

## Image handler

`createImageHandler(options)` serves optimized images (`/_image?url=...&w=...&q=...`).

### Remote source allowlist (security)

Relative `url` values (starting with `/`) are always allowed — they resolve to
objects in the deployment's assets bucket.

Remote `http(s)` URLs are **denied by default** (HTTP 403). Previously any
remote URL was fetched, which made the function an open proxy (SSRF). To allow
specific remote hosts, set:

- `AYC_IMAGE_ALLOWED_HOSTS` — comma-separated list of allowed hostnames.
  A leading dot allows a domain and all of its subdomains:

  ```
  AYC_IMAGE_ALLOWED_HOSTS=images.example.com,.cdn.example.org
  ```

  - `images.example.com` — exact host match only.
  - `.cdn.example.org` — matches `cdn.example.org` and any subdomain.

Fetched remote responses are also capped at 10 MB; larger sources are rejected.
