package io.conclave.agentsgo;

final class BundledNavigation {
    private BundledNavigation() {}

    static boolean allows(String scheme, String host, int port, String path) {
        return "https".equals(scheme) && "localhost".equals(host) && port == -1
            && ("/".equals(path) || "/index.html".equals(path));
    }
}
