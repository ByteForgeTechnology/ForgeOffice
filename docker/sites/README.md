Extra sites for the optional TLS proxy (`docker/Caddyfile` imports every `*.caddy` file here).
The installer writes `office.caddy` when Euro-Office gets its own HTTPS address, for example:

    office.example.com {
    	reverse_proxy office:80
    }
