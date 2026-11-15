package com.harisdevlab.nxbeam

import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * A controller on the phone or TV becomes the Switch's virtual controller.
 * Face buttons go by position (the bottom button is the Switch's B), so the
 * hands do what they would on a Joy-Con.
 */
class Gamepad(private val onChange: (PadState) -> Unit) {
    private var buttons = 0
    private var lx = 0; private var ly = 0; private var rx = 0; private var ry = 0
    private var hat = 0
    private var trig = 0

    companion object {
        fun isPad(source: Int) =
            source and InputDevice.SOURCE_GAMEPAD == InputDevice.SOURCE_GAMEPAD ||
                source and InputDevice.SOURCE_JOYSTICK == InputDevice.SOURCE_JOYSTICK

        private val KEYS = mapOf(
            KeyEvent.KEYCODE_BUTTON_A to Proto.B_B,
            KeyEvent.KEYCODE_BUTTON_B to Proto.B_A,
            KeyEvent.KEYCODE_BUTTON_X to Proto.B_Y,
            KeyEvent.KEYCODE_BUTTON_Y to Proto.B_X,
            KeyEvent.KEYCODE_BUTTON_L1 to Proto.B_L,
            KeyEvent.KEYCODE_BUTTON_R1 to Proto.B_R,
            KeyEvent.KEYCODE_BUTTON_L2 to Proto.B_ZL,
            KeyEvent.KEYCODE_BUTTON_R2 to Proto.B_ZR,
            KeyEvent.KEYCODE_BUTTON_THUMBL to Proto.B_LSTICK,
            KeyEvent.KEYCODE_BUTTON_THUMBR to Proto.B_RSTICK,
            KeyEvent.KEYCODE_BUTTON_START to Proto.B_PLUS,
            KeyEvent.KEYCODE_BUTTON_SELECT to Proto.B_MINUS,
            KeyEvent.KEYCODE_BUTTON_MODE to Proto.B_HOME,
            KeyEvent.KEYCODE_DPAD_UP to Proto.B_UP,
            KeyEvent.KEYCODE_DPAD_DOWN to Proto.B_DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT to Proto.B_LEFT,
            KeyEvent.KEYCODE_DPAD_RIGHT to Proto.B_RIGHT,
        )
    }

    /** true when the key belonged to a controller and was taken */
    fun key(e: KeyEvent): Boolean {
        if (!isPad(e.source)) return false
        val bit = KEYS[e.keyCode] ?: return false
        if (e.action == KeyEvent.ACTION_DOWN) buttons = buttons or (1 shl bit)
        else if (e.action == KeyEvent.ACTION_UP) buttons = buttons and (1 shl bit).inv()
        emit()
        return true
    }

    fun motion(e: MotionEvent): Boolean {
        if (!isPad(e.source) || e.action != MotionEvent.ACTION_MOVE) return false
        fun axis(a: Int): Float {
            val v = e.getAxisValue(a)
            val range = e.device?.getMotionRange(a, e.source)
            val flat = range?.flat ?: 0.08f
            return if (abs(v) <= maxOf(flat, 0.08f)) 0f else v
        }
        fun stick(v: Float) = (v * 32767f).roundToInt().coerceIn(-32767, 32767)
        lx = stick(axis(MotionEvent.AXIS_X)); ly = stick(-axis(MotionEvent.AXIS_Y))
        rx = stick(axis(MotionEvent.AXIS_Z)); ry = stick(-axis(MotionEvent.AXIS_RZ))
        hat = 0
        val hx = e.getAxisValue(MotionEvent.AXIS_HAT_X); val hy = e.getAxisValue(MotionEvent.AXIS_HAT_Y)
        if (hx < -0.5f) hat = hat or (1 shl Proto.B_LEFT)
        if (hx > 0.5f) hat = hat or (1 shl Proto.B_RIGHT)
        if (hy < -0.5f) hat = hat or (1 shl Proto.B_UP)
        if (hy > 0.5f) hat = hat or (1 shl Proto.B_DOWN)
        trig = 0
        if (maxOf(e.getAxisValue(MotionEvent.AXIS_LTRIGGER), e.getAxisValue(MotionEvent.AXIS_BRAKE)) > 0.5f) trig = trig or (1 shl Proto.B_ZL)
        if (maxOf(e.getAxisValue(MotionEvent.AXIS_RTRIGGER), e.getAxisValue(MotionEvent.AXIS_GAS)) > 0.5f) trig = trig or (1 shl Proto.B_ZR)
        emit()
        return true
    }

    private fun emit() = onChange(PadState(buttons or hat or trig, lx, ly, rx, ry))
}
