package dev.maxhogan.healthy.companion.tasker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskerPluginTest {
    @Test
    fun `the intents are the standard Locale plugin ones`() {
        assertEquals("com.twofortyfouram.locale.intent.action.EDIT_SETTING", TaskerPlugin.ACTION_EDIT)
        assertEquals("com.twofortyfouram.locale.intent.action.FIRE_SETTING", TaskerPlugin.ACTION_FIRE)
        assertEquals("com.twofortyfouram.locale.intent.extra.BUNDLE", TaskerPlugin.EXTRA_BUNDLE)
        assertEquals("com.twofortyfouram.locale.intent.extra.BLURB", TaskerPlugin.EXTRA_BLURB)
    }

    @Test
    fun `only a fire intent carrying this plugin's own marker triggers a refresh`() {
        assertTrue(TaskerPlugin.isRefresh(TaskerPlugin.ACTION_FIRE, TaskerPlugin.ACTION_REFRESH))
        assertFalse(TaskerPlugin.isRefresh(TaskerPlugin.ACTION_FIRE, null))
        assertFalse(TaskerPlugin.isRefresh(TaskerPlugin.ACTION_FIRE, "something-else"))
        assertFalse(TaskerPlugin.isRefresh(TaskerPlugin.ACTION_EDIT, TaskerPlugin.ACTION_REFRESH))
        assertFalse(TaskerPlugin.isRefresh(null, TaskerPlugin.ACTION_REFRESH))
    }
}
