package org.aerie.app;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

import static org.junit.Assert.*;

public class UpdatePolicyTest {
    private static final String HASH = "a".repeat(64);
    private static final String CERT = "b".repeat(64);

    @Test public void acceptsOnlyVerifiedStrictlyNewerReleaseMetadata() {
        UpdatePolicy.validateRelease(true, true, "aerie 2.apk", "/downloads/aerie%202.apk",
                100, HASH, "2.0.0", 10, CERT, 9);
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateRelease(
                true, false, "aerie.apk", "/downloads/aerie.apk", 100, HASH, "2.0.0", 10, CERT, 9));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateRelease(
                true, true, "../aerie.apk", "/downloads/../aerie.apk", 100, HASH, "2.0.0", 10, CERT, 9));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateRelease(
                true, true, "aerie.apk", "https://attacker.test/aerie.apk", 100, HASH, "2.0.0", 10, CERT, 9));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateRelease(
                true, true, "aerie.apk", "/downloads/aerie.apk", 100, HASH, "2.0.0", 9, CERT, 9));
    }

    @Test public void validatesExactResumeBoundariesAndLengths() {
        UpdatePolicy.DownloadPlan resumed = UpdatePolicy.validateDownloadResponse(
                206, 40, 100, "60", "bytes 40-99/100");
        assertTrue(resumed.append);
        assertEquals(60, resumed.expectedBytes);
        UpdatePolicy.DownloadPlan restarted = UpdatePolicy.validateDownloadResponse(
                200, 40, 100, "100", null);
        assertFalse(restarted.append);
        assertEquals(100, restarted.expectedBytes);
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.validateDownloadResponse(
                206, 40, 100, "60", "bytes 39-98/100"));
        assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.checkedByteCount(59, 2, 60));
    }

    @Test public void archiveMustMatchInstalledSignerSetAndDeclaredCertificate() {
        Set<String> installed = new HashSet<>(); installed.add(CERT);
        Set<String> archive = new HashSet<>(); archive.add(CERT);
        assertTrue(UpdatePolicy.sameSignerSet(installed, archive, CERT));
        archive.add("c".repeat(64));
        assertFalse(UpdatePolicy.sameSignerSet(installed, archive, CERT));
        assertFalse(UpdatePolicy.sameSignerSet(installed, installed, "d".repeat(64)));
    }

    @Test public void offersOnlyCompleteReadyBuildsNewerThanInstalledApp() {
        assertTrue(UpdatePolicy.canOfferReadyRelease(11, 10, 100, 100));
        assertFalse(UpdatePolicy.canOfferReadyRelease(10, 10, 100, 100));
        assertFalse(UpdatePolicy.canOfferReadyRelease(9, 10, 100, 100));
        assertFalse(UpdatePolicy.canOfferReadyRelease(11, 10, 100, -1));
        assertFalse(UpdatePolicy.canOfferReadyRelease(11, 10, 100, 99));
    }
}
