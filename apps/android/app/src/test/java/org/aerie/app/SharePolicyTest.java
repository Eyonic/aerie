package org.aerie.app;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

import static org.junit.Assert.*;

public class SharePolicyTest {
    @Test public void filenamesCannotEscapeStagingOrRemoteDestination() {
        assertEquals("_.._secret_.txt", SharePolicy.safeFilename("/../secret\\.txt", 0));
        assertEquals("Shared file 2", SharePolicy.safeFilename(" .. ", 1));
        assertFalse(SharePolicy.safeFilename("folder/name.txt", 0).contains("/"));
    }

    @Test public void duplicateNamesAreDisambiguatedWithoutLosingExtension() {
        Set<String> used = new HashSet<>();
        assertEquals("photo.jpg", SharePolicy.makeUnique("photo.jpg", used));
        assertEquals("photo (2).jpg", SharePolicy.makeUnique("photo.jpg", used));
        assertEquals("PHOTO (3).jpg", SharePolicy.makeUnique("PHOTO.jpg", used));
    }

    @Test public void destinationAndSizeLimitsAreClosedLists() {
        assertTrue(SharePolicy.destinationAllowed("/Inbox"));
        assertFalse(SharePolicy.destinationAllowed("/../../Admin"));
        assertEquals(10, SharePolicy.checkedItem(4, 6));
        assertThrows(IllegalArgumentException.class,
                () -> SharePolicy.checkedItem(SharePolicy.MAX_ITEM_BYTES, 1));
        assertThrows(IllegalArgumentException.class,
                () -> SharePolicy.checkedTotal(SharePolicy.MAX_BATCH_BYTES, 1));
    }
}
