package org.aerie.app;

import org.junit.Test;

import java.util.Arrays;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public final class SyncFolderPolicyTest {
    @Test public void staleRunningStateRequiresAnExpiredHeartbeat() {
        long now = 2_000_000L;
        assertFalse(SyncFolderPolicy.staleRun(false, 0, now));
        assertFalse(SyncFolderPolicy.staleRun(true, now - 60_000L, now));
        assertTrue(SyncFolderPolicy.staleRun(true, 0, now));
        assertTrue(SyncFolderPolicy.staleRun(true, now - 16L * 60L * 1000L, now));
    }

    @Test public void twoWayRequiresWriteButBackupOnlyRequiresRead() {
        assertTrue(SyncFolderPolicy.accessSatisfies(true, false, "backup"));
        assertFalse(SyncFolderPolicy.accessSatisfies(true, false, "two"));
        assertTrue(SyncFolderPolicy.accessSatisfies(true, true, "two"));
        assertFalse(SyncFolderPolicy.accessSatisfies(false, true, "backup"));
    }

    @Test public void legacyBasesAreAdoptedExactlyWhileNewBasesAreDeviceUnique() {
        assertEquals("Sync/Pixel 8 Work", SyncFolderPolicy.legacyRemoteBase("Pixel 8", "Work", false));
        assertEquals("Photos/Camera/Pixel 8", SyncFolderPolicy.legacyRemoteBase("Pixel 8", "Camera backup", true));
        String first = SyncFolderPolicy.newRemoteBase("Pixel 8", "Work", false, "device-one");
        String again = SyncFolderPolicy.newRemoteBase("Pixel 8", "Work", false, "device-one");
        String second = SyncFolderPolicy.newRemoteBase("Pixel 8", "Work", false, "device-two");
        assertEquals(first, again);
        assertNotEquals(first, second);
        assertTrue(SyncFolderPolicy.validRemoteBase(first));
        for (String invalid : Arrays.asList("", "Other/x", "Sync/../x", "Sync//x"))
            assertFalse(SyncFolderPolicy.validRemoteBase(invalid));
    }

    @Test public void endpointNormalizationPreservesReverseProxyPathsAndDeduplicates() {
        assertEquals(Arrays.asList("https://example.test/aerie", "http://192.168.1.11:8200"),
                ServerEndpointResolver.ordered(" HTTPS://Example.Test:443/aerie/ ",
                        "https://example.test/aerie", "http://192.168.1.11:8200"));
        assertNull(ServerEndpointResolver.normalize("https://user@example.test"));
        assertNull(ServerEndpointResolver.normalize("https://example.test/?secret=x"));
        assertNull(ServerEndpointResolver.normalize("https://example.test/%2e./admin"));
        assertNull(ServerEndpointResolver.normalize("http://example.test/aerie"));
        assertEquals("http://unraid:8200/aerie", ServerEndpointResolver.normalize("http://unraid:8200/aerie"));
        assertEquals("http://[fd00::11]:8200", ServerEndpointResolver.normalize("http://[fd00::11]:8200"));
    }
}
