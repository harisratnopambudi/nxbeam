package com.harisdevlab.nxbeam

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** where recordings and screenshots go: Movies/NXBeam and Pictures/NXBeam in the gallery */
class MediaFile private constructor(
    private val context: Context,
    val name: String,
    private val uri: Uri?,
    private val file: File?,
    val pfd: ParcelFileDescriptor?,
) {
    val path: String? get() = file?.absolutePath

    /** makes the file visible in the gallery, or removes it when nothing was written */
    fun finish(keep: Boolean) {
        try { pfd?.close() } catch (_: Exception) { }
        if (uri != null) {
            if (keep) {
                context.contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            } else context.contentResolver.delete(uri, null, null)
        } else if (file != null) {
            if (keep) MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), null, null) else file.delete()
        }
    }

    companion object {
        fun stamp(): String = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())

        /** needs WRITE_EXTERNAL_STORAGE below Android 10 */
        fun needsPermission() = Build.VERSION.SDK_INT < 29

        fun create(context: Context, video: Boolean): MediaFile? {
            val name = "NXBeam_${stamp()}." + if (video) "mp4" else "png"
            val mime = if (video) "video/mp4" else "image/png"
            return try {
                if (Build.VERSION.SDK_INT >= 29) {
                    val collection = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                        put(MediaStore.MediaColumns.MIME_TYPE, mime)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/NXBeam")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val uri = context.contentResolver.insert(collection, values) ?: return null
                    val pfd = context.contentResolver.openFileDescriptor(uri, "rw") ?: return null
                    MediaFile(context, name, uri, null, pfd)
                } else {
                    @Suppress("DEPRECATION")
                    val dir = File(Environment.getExternalStoragePublicDirectory(
                        if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES), "NXBeam")
                    dir.mkdirs()
                    val f = File(dir, name)
                    MediaFile(context, name, null, f, ParcelFileDescriptor.open(f,
                        ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_TRUNCATE))
                }
            } catch (e: Exception) { null }
        }

        fun saveImage(context: Context, bmp: Bitmap): String? {
            val m = create(context, false) ?: return null
            val ok = try {
                ParcelFileDescriptor.AutoCloseOutputStream(m.pfd).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            } catch (_: Exception) { false }
            m.finish(ok)
            return if (ok) m.name else null
        }
    }
}
