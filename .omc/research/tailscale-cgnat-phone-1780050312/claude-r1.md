1. Lens: Authoritative sources (Tailscale official docs, GitHub issues)
2. Findings
- Tailscale assigns 100.64.0.0/10 (RFC6598 CGNAT) addresses; ISPs and mobile carriers commonly use the SAME range, causing conflicts. https://tailscale.com/docs/reference/troubleshooting/network-configuration/cgnat-conflicts
- Documented Android symptom: moving from Wi-Fi to LTE/5G makes ALL HTTP requests fail (even non-Tailscale); turning Tailscale off fixes instantly. Matches our phone abort. https://github.com/tailscale/tailscale/issues/4611
- Official fix #1: disable IPv4 in tailnet via `disable-ipv4` node attribute -> IPv6 only. Caveat: devices must support IPv6; IPv4-only resources become unreachable. https://tailscale.com/docs/reference/troubleshooting/network-configuration/cgnat-conflicts
- Official fix (Linux only): `--netfilter-mod=off` avoids the 100.64/10 drop rule (security tradeoff). https://tailscale.com/docs/reference/troubleshooting/network-configuration/cgnat-conflicts
- Community fix: change Tailscale ipPool to a narrower subnet (e.g. 100.100.96.0/20) to reduce collision (NOT in official CGNAT doc; blog-sourced). https://avilpage.com/2024/09/tailscale-cgnat-conflicts-resolution.html
- Android MagicDNS NXDOMAIN is a known class of issues; Android Private DNS (DoT) and Android-specific DNS bugs cause it. https://github.com/tailscale/tailscale/issues/18312 , https://github.com/tailscale/tailscale/issues/8006
- Alternatives for phone access: Tailscale Funnel (public HTTPS, double opt-in, DERP) or Cloudflare Tunnel + Access (public + identity gating). For own-phone private use, keep Tailscale private. https://guides.happier.dev/cloudflare-tunnel-vs-tailscale-funnel-vs-ngrok-for-claude-code-codex-opencode
3. Source quality: Tailscale docs + GitHub issues = primary/official. avilpage + happier.dev = blog (secondary).
4. Contradictions: Official CGNAT fix is "use IPv6 only", but user's phone got ERR_ADDRESS_UNREACHABLE on IPv6 -> IPv6 path not currently working on phone. Disabling IPv4 may force/repair IPv6, but unverified for this phone.
5. Open questions: Does disabling IPv4 (forcing IPv6) actually restore phone reachability when phone IPv6 to tailnet was unreachable? Is the phone on cellular or Wi-Fi during failures?
6. Confidence: high on root cause (CGNAT), medium on which fix will work given IPv6-unreachable symptom.
