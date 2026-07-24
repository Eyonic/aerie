package org.aerie.app;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class SyncJournalTest {
    @Test public void durableDeviceIdNeverChangesAfterItsFirstSelection() {
        String first = SyncJournal.selectStableDeviceId(null, "device_pairing_identity", "android-new");
        assertEquals("device_pairing_identity", first);
        assertEquals(first, SyncJournal.selectStableDeviceId(first, "device_repaired_identity", "android-other"));
        assertEquals("android-fallback", SyncJournal.selectStableDeviceId("bad id", "bad id", "android-fallback"));
        assertThrows(IllegalArgumentException.class,
                () -> SyncJournal.selectStableDeviceId("bad id", null, "also bad"));
    }

    @Test public void stateScopeSeparatesServersAndRemoteBases() {
        String original = SyncJournal.stateScope("https://one.example", "Sync/Phone Work");
        assertEquals(original, SyncJournal.stateScope("https://one.example", "Sync/Phone Work"));
        assertNotEquals(original, SyncJournal.stateScope("https://two.example", "Sync/Phone Work"));
        assertNotEquals(original, SyncJournal.stateScope("https://one.example", "Sync/Phone Personal"));
        assertTrue(original.matches("^[a-f0-9]{24}$"));
    }

    @Test public void acknowledgesOnlyAfterApplyAndDurablePersist() throws Exception {
        List<String> order = new ArrayList<>();
        SyncJournal.commitRemoteApply(() -> order.add("apply"), () -> order.add("persist"),
                () -> order.add("ack"));
        assertEquals(Arrays.asList("apply", "persist", "ack"), order);

        AtomicBoolean persistedAfterApplyFailure = new AtomicBoolean();
        AtomicBoolean ackedAfterApplyFailure = new AtomicBoolean();
        assertThrows(Exception.class, () -> SyncJournal.commitRemoteApply(
                () -> { throw new Exception("apply_failed"); },
                () -> persistedAfterApplyFailure.set(true),
                () -> ackedAfterApplyFailure.set(true)));
        assertFalse(persistedAfterApplyFailure.get());
        assertFalse(ackedAfterApplyFailure.get());

        AtomicBoolean ackedAfterPersistFailure = new AtomicBoolean();
        assertThrows(Exception.class, () -> SyncJournal.commitRemoteApply(
                () -> { },
                () -> { throw new Exception("persist_failed"); },
                () -> ackedAfterPersistFailure.set(true)));
        assertFalse(ackedAfterPersistFailure.get());
    }

    @Test public void cursorCannotRegressOrClaimStalledPagination() {
        assertEquals(12, SyncJournal.validatePageCursor(7, 12, true, 8, 10, 12));
        assertEquals(12, SyncJournal.validatePageCursor(12, 12, false));
        assertThrows(IllegalArgumentException.class,
                () -> SyncJournal.validatePageCursor(12, 11, false));
        assertThrows(IllegalArgumentException.class,
                () -> SyncJournal.validatePageCursor(12, 12, true, 12));
        assertThrows(IllegalArgumentException.class,
                () -> SyncJournal.validatePageCursor(12, 12, false, 12));
        assertThrows(IllegalArgumentException.class,
                () -> SyncJournal.validatePageCursor(12, 13, true));
        assertThrows(IllegalArgumentException.class,
                () -> SyncJournal.validatePageCursor(7, 12, false, 8, 8, 12));
        assertThrows(IllegalArgumentException.class,
                () -> SyncJournal.validatePageCursor(7, 12, false, 8, 10, 11));
        assertThrows(IllegalArgumentException.class,
                () -> SyncJournal.validatePageCursor(7, 12, false, 8, 13, 12));
    }

    @Test public void fullManifestIsAuthoritativeForPreviouslyTrackedEntries() {
        HashSet<String> tracked = new HashSet<>(Arrays.asList("stable-c", "stable-a", "stable-b"));
        HashSet<String> manifest = new HashSet<>(Arrays.asList("stable-b", "stable-d"));
        assertEquals(Arrays.asList("stable-a", "stable-c"),
                SyncJournal.absentFromManifest(tracked, manifest));
    }
}
