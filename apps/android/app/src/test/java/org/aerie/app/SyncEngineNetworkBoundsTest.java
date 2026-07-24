package org.aerie.app;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class SyncEngineNetworkBoundsTest {
    @Test public void fullResponsesMustMatchTheExactFileSize() {
        SyncEngine.DownloadResponsePlan plan = SyncEngine.validateDownloadResponse(
                200, 100, 1_000, "1000", null);
        assertFalse(plan.append);
        assertEquals(1_000, plan.expectedBytes);
        assertThrows(IllegalArgumentException.class, () -> SyncEngine.validateDownloadResponse(
                200, 100, 1_000, "900", null));
        assertThrows(IllegalArgumentException.class, () -> SyncEngine.validateDownloadResponse(
                200, 0, 1_000, "1000", "bytes 0-999/1000"));
    }

    @Test public void resumedResponsesRequireAnExactContentRangeAndRemainingLength() {
        SyncEngine.DownloadResponsePlan plan = SyncEngine.validateDownloadResponse(
                206, 400, 1_000, "600", "bytes 400-999/1000");
        assertTrue(plan.append);
        assertEquals(600, plan.expectedBytes);
        assertThrows(IllegalArgumentException.class, () -> SyncEngine.validateDownloadResponse(
                206, 400, 1_000, "601", "bytes 400-999/1000"));
        assertThrows(IllegalArgumentException.class, () -> SyncEngine.validateDownloadResponse(
                206, 400, 1_000, "600", "bytes 399-998/1000"));
        assertThrows(IllegalArgumentException.class, () -> SyncEngine.validateDownloadResponse(
                206, 400, 1_000, "600", null));
    }

    @Test public void streamingGuardRejectsTheFirstChunkThatWouldExceedExpectedBytes() {
        long received = SyncEngine.checkedDownloadCount(0, 512, 1_000);
        assertEquals(512, received);
        assertThrows(IllegalArgumentException.class,
                () -> SyncEngine.checkedDownloadCount(512, 489, 1_000));
        assertEquals(1_000, SyncEngine.checkedDownloadCount(512, 488, 1_000));
        assertThrows(IllegalArgumentException.class,
                () -> SyncEngine.checkedDownloadCount(1_000, 1, 1_000));
    }
}
