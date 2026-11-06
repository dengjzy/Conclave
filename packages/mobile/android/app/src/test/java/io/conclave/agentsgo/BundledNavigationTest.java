package io.conclave.agentsgo;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class BundledNavigationTest {
    @Test public void allowsOnlyBundledEntryDocuments() {
        assertTrue(BundledNavigation.allows("https", "localhost", -1, "/"));
        assertTrue(BundledNavigation.allows("https", "localhost", -1, "/index.html"));
        assertFalse(BundledNavigation.allows("https", "localhost", -1, "/assets/wasm_exec.js"));
        assertFalse(BundledNavigation.allows("https", "localhost", -1, "/_capacitor_http_interceptor_"));
    }
    @Test public void rejectsNetworkOriginsAndExecutableSchemes() {
        assertFalse(BundledNavigation.allows("https", "example.com", -1, "/"));
        assertFalse(BundledNavigation.allows("http", "localhost", -1, "/"));
        assertFalse(BundledNavigation.allows("https", "localhost", 443, "/"));
        assertFalse(BundledNavigation.allows("https", "localhost.evil.test", -1, "/"));
        assertFalse(BundledNavigation.allows("javascript", null, -1, null));
        assertFalse(BundledNavigation.allows("file", null, -1, "/index.html"));
        assertFalse(BundledNavigation.allows("data", null, -1, null));
        assertFalse(BundledNavigation.allows(null, null, -1, null));
    }
}
