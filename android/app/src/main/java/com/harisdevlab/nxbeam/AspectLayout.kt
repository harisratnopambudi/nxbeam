package com.harisdevlab.nxbeam

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.widget.FrameLayout

/** fits its child to the picture's aspect ratio, centered, black around it */
class AspectLayout(context: Context, attrs: AttributeSet? = null) : FrameLayout(context, attrs) {
    private var ratio = 16f / 9f

    fun setAspect(w: Int, h: Int) {
        if (w <= 0 || h <= 0) return
        val r = w.toFloat() / h
        if (r != ratio) { ratio = r; requestLayout() }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        var cw = w
        var ch = (w / ratio).toInt()
        if (ch > h) { ch = h; cw = (h * ratio).toInt() }
        setMeasuredDimension(w, h)
        for (i in 0 until childCount) {
            getChildAt(i).measure(MeasureSpec.makeMeasureSpec(cw, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(ch, MeasureSpec.EXACTLY))
        }
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        for (i in 0 until childCount) {
            val c: View = getChildAt(i)
            val x = (r - l - c.measuredWidth) / 2
            val y = (b - t - c.measuredHeight) / 2
            c.layout(x, y, x + c.measuredWidth, y + c.measuredHeight)
        }
    }
}
