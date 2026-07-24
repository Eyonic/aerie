package org.aerie.app;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public final class AerieDocumentIdTest {
    private static final String SCOPE = "0123456789abcdef0123456789abcdef";
    private static final String OTHER_SCOPE = "fedcba9876543210fedcba9876543210";

    @Test public void roundTripsCanonicalPaths() {
        roundTrip("/");
        roundTrip("/Documents/Quarterly report 🕊.pdf");
        roundTrip("/Photos/2026/July");
    }

    @Test public void rejectsTraversalAliasesAndMalformedIds() {
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.normalize("/safe/../escape"));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.normalize(""));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.normalize(null));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.normalize("relative/path"));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.child("/Documents", "../secret"));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.child("/Documents", "bad/name"));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.child("/Documents", "bad\ud800name"));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.pathFor(SCOPE, "p:2f"));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.pathFor(SCOPE,
                "g:" + SCOPE + ":p:2F446f63756d656e7473"));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.pathFor(SCOPE,
                "g:" + SCOPE + ":p:0g"));
        assertThrows(IllegalArgumentException.class, () -> AerieDocumentId.pathFor(OTHER_SCOPE,
                AerieDocumentId.forPath(SCOPE, "/Documents")));
        assertFalse(AerieDocumentId.rootId(SCOPE).equals(AerieDocumentId.rootId(OTHER_SCOPE)));
    }

    @Test public void descendantChecksHonorSegmentBoundaries() {
        assertTrue(AerieDocumentId.isChild("/Documents", "/Documents/Work/file.txt"));
        assertFalse(AerieDocumentId.isChild("/Documents", "/Documentary/file.txt"));
    }

    private static void roundTrip(String path) {
        String normalized = AerieDocumentId.normalize(path);
        String decoded = AerieDocumentId.pathFor(SCOPE, AerieDocumentId.forPath(SCOPE, path));
        if (!normalized.equals(decoded)) throw new AssertionError(path + " -> " + decoded);
    }
}
