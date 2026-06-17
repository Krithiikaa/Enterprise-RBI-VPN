Precision RBI — MITM CA
=======================
http-mitm-proxy (proxy-service) generates its CA here on first HTTPS request:
  ca/certs/ca.pem   <- the root cert clients must trust for HTTPS INSPECTION
  ca/keys/ca.private.key

Download the cert from the gateway any time at:  https://<SERVER>/ca.crt

IMPORTANT (see ARCHITECTURE §3): a Chrome extension CANNOT install this into the
OS/browser trust store. For full TLS inspection of NON-isolated sites, push
ca.pem to managed devices via MDM / Group Policy. The RBI isolation path needs
NO client cert (the risky site renders server-side; the client receives pixels).

The private key NEVER leaves this host. Rotate by deleting ca/ and restarting
proxy-service (all clients must then re-trust the new cert).
