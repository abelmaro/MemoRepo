# Optional corporate CA certificates

If your network inspects HTTPS traffic, place its public CA certificates here
before building the images. Export certificates already trusted by your
operating system or obtain them from your IT team. Use PEM format with a `.crt`
extension and one certificate per file, including the root and any required
intermediate CA certificates. Do not include private keys.

This directory can remain empty apart from this README on networks that use
public certificate authorities. Local certificate files are ignored by Git.
They are included in both build stages for dependency downloads and in the API
runtime for Git, curl, and Node HTTPS requests; TLS verification remains enabled.

After adding, replacing, or removing a certificate, rebuild and recreate the containers:

```sh
docker compose up -d --build
```

Images built with corporate certificates retain them, so use those images only
in the corresponding trusted environment. The compiler tools required by native
dependencies are installed in the build stage and are absent from the runtime.

See [Docker's CA certificate guide](https://docs.docker.com/engine/network/ca-certs/)
for the container trust-store mechanism.
