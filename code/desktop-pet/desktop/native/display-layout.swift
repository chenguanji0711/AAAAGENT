import Foundation
import CoreGraphics

// Private shell geometry in logical points. Screen fitting never writes preferences.
struct PetDisplayLayout {
    static let aspect = 340.0 / 360.0
    static let ballSize = 44.0
    let frame: CGRect
    let modelWidth: Double
    let modelHeight: Double
    let drawerHeight: Double
    let modelFrame: CGRect
    let petFrame: CGRect
    let drawerFrame: CGRect
    let viewport: CGRect
    let placement: String
    let collapsed: Bool
    let ballFrame: CGRect
    let speechFrame: CGRect
    let quickFrame: CGRect
    // Anchor is the MODEL's screen-space top centre, never the enclosing window.
    static func fit(width: Double, open: Bool, screen: CGRect, anchor: CGPoint, collapsed: Bool = false, speechVisible: Bool = true, speechHeight: Double = 84, quickHeight: Double = 56) -> PetDisplayLayout {
        let gap = 8.0
        // Keep a stable upper strip even while hidden: text height and the HUD
        // switch never resize or shift the character. Tiny screens fit both surfaces.
        let reservedSpeechHeight = min(160.0, max(1, screen.height / 3))
        let sw = min(260.0, max(1, screen.width))
        let composerHeight = min(max(1, screen.height-reservedSpeechHeight-gap), min(112, max(40, quickHeight)))
        let available = max(1, screen.height - composerHeight - reservedSpeechHeight - gap)
        let modelWidth = max(1, min(width, max(1, screen.width - 20), available / aspect))
        let modelHeight = modelWidth * aspect
        let petWidth = min(screen.width, modelWidth + 20)
        let petHeight = min(max(1, screen.height-reservedSpeechHeight-gap), modelHeight + composerHeight)
        let groupWidth = max(petWidth, sw)
        // The character canvas is wider than the visible art, so the group may overhang the right
        // edge to let the visible figure line up over the Dock's Trash. The transparent margin is
        // what gets clipped, never the figure.
        // Never allow the model centre beyond its screen on a small display.
        let maxOverhang = min(270.0, max(0, (groupWidth-min(20,screen.width))/2))
        let groupX = min(max(anchor.x-groupWidth/2,screen.minX),screen.maxX-groupWidth+maxOverhang)
        let x = groupX + (groupWidth-petWidth)/2
        let y = min(max(anchor.y-petHeight,screen.minY),screen.maxY-petHeight-reservedSpeechHeight-gap)
        let pet = CGRect(x:x,y:y,width:petWidth,height:petHeight)
        let model = CGRect(x:pet.midX-modelWidth/2,y:pet.maxY-modelHeight,width:modelWidth,height:modelHeight)
        let sh = min(max(1, speechHeight), reservedSpeechHeight)
        // Controls stay on screen even when the model canvas overhangs the edge.

        let speechX = min(max(pet.midX-sw/2,screen.minX),screen.maxX-sw)

        let speech = CGRect(x:speechX,y:pet.maxY+gap,width:sw,height:sh)
    // The quick composer owns its own screen rect: never wider than the screen, clamped on both
    // sides, pinned to the strip below the model, so the native clip always contains it.
    let quickWidth = min(340.0, max(1, screen.width))
    let fittedQuickHeight = min(composerHeight, petHeight)
    let quickX = min(max(pet.midX - quickWidth/2, screen.minX), max(screen.minX, screen.maxX - quickWidth))
    let quick = CGRect(x: quickX, y: pet.minY, width: quickWidth, height: fittedQuickHeight)
        let drawerWidth = min(480, max(1, screen.width - 20))
        let drawerX = min(max(pet.midX-drawerWidth/2,screen.minX+min(10,screen.width/2)),screen.maxX-drawerWidth-min(10,screen.width/2))
        let below = max(0,pet.minY-screen.minY-gap), above = max(0,screen.maxY-speech.maxY-gap)
        let right = max(0,screen.maxX-pet.maxX-gap), left = max(0,pet.minX-screen.minX-gap)
        var drawer = CGRect.zero, placement = "hidden"
        func vertical(_ bottom:Bool,_ height:Double) -> CGRect {
            CGRect(x:drawerX,y:bottom ? pet.minY-gap-height : speech.maxY+gap,width:drawerWidth,height:height)
        }
        func side(_ useRight:Bool) -> CGRect {
            let w=min(drawerWidth,useRight ? right:left), h=min(540,screen.height)
            return CGRect(x:useRight ? pet.maxX+gap : pet.minX-gap-w,y:min(max(pet.maxY-h,screen.minY),screen.maxY-h),width:w,height:h)
        }
        if open {
            // Try full reading space before accepting a smaller neighbouring slot.
            if below >= 540 { drawer=vertical(true,540);placement="below" }
            else if max(left,right) >= drawerWidth && screen.height >= 540 {
                let useRight=right>=left;drawer=side(useRight);placement=useRight ? "right":"left"
            } else if above >= 540 { drawer=vertical(false,540);placement="above" }
            else if below >= 340 { drawer=vertical(true,min(540,below));placement="below" }
            else if max(left,right) >= min(320,drawerWidth) {
                let useRight=right>=left;drawer=side(useRight)
                placement=useRight ? "right":"left"
            } else if above >= 340 { drawer=vertical(false,min(540,above));placement="above" }
            else {
                // On a screen almost filled by the model, a scrollable overlay is
                // the only available space. It never changes the model's geometry.
                drawer=CGRect(x:drawerX,y:screen.minY,width:drawerWidth,height:min(540,screen.height))
                placement="overlay"
            }
        }
        let diameter = max(1,min(ballSize,screen.width,screen.height))
        let ball = CGRect(x:min(max(anchor.x-diameter/2,screen.minX),screen.maxX-diameter),
                          y:min(max(anchor.y-diameter,screen.minY),screen.maxY-diameter),width:diameter,height:diameter)
        // The native clip includes the vertically stacked HUD above the character.
        var visibleFrame = open ? pet.union(drawer) : pet
        if speechVisible { visibleFrame = visibleFrame.union(speech) }
    visibleFrame = visibleFrame.union(quick)
        // The model canvas may overhang, but the native clip (and its transparent blank area)
        // must never extend past the screen and cover the Dock.
        func clippedToScreen(_ r: CGRect) -> CGRect {
            let x0 = min(max(r.minX,screen.minX),screen.maxX), y0 = min(max(r.minY,screen.minY),screen.maxY)
            let x1 = min(max(r.maxX,screen.minX),screen.maxX), y1 = min(max(r.maxY,screen.minY),screen.maxY)
            return CGRect(x:x0,y:y0,width:max(0,x1-x0),height:max(0,y1-y0))
        }
        return PetDisplayLayout(frame:collapsed ? ball:clippedToScreen(visibleFrame),modelWidth:modelWidth,modelHeight:modelHeight,drawerHeight:drawer.height,modelFrame:model,petFrame:pet,drawerFrame:drawer,viewport:screen,placement:placement,collapsed:collapsed,ballFrame:ball,speechFrame:speech,quickFrame:quick)
    }

    // CSS origin is the screen's top-left; AppKit's is the bottom-left.
    var webOrigin: CGPoint { CGPoint(x:viewport.minX-frame.minX,y:viewport.minY-frame.minY) }
    var configuration: [String:Any] {
        ["quickLeft":quickFrame.minX-viewport.minX,"quickTop":viewport.maxY-quickFrame.maxY,"quickWidth":quickFrame.width,"quickHeight":quickFrame.height,"clipLeft":frame.minX-viewport.minX,"clipTop":viewport.maxY-frame.maxY,"clipWidth":frame.width,"clipHeight":frame.height,
         "speechLeft":speechFrame.minX-viewport.minX,"speechTop":viewport.maxY-speechFrame.maxY,"speechWidth":speechFrame.width,"speechHeight":speechFrame.height,
         "speechMaxHeight":min(160,max(1,viewport.height/3)),"modelWidth":modelWidth,"modelHeight":modelHeight,"drawerHeight":drawerHeight,
         "petHeight":petFrame.height,"petLeft":petFrame.minX-viewport.minX,"petTop":viewport.maxY-petFrame.maxY,"petWidth":petFrame.width,
         "drawerLeft":drawerFrame.minX-viewport.minX,"drawerTop":viewport.maxY-drawerFrame.maxY,"drawerWidth":drawerFrame.width,"placement":placement,
         "collapsed":collapsed,"ballLeft":ballFrame.minX-viewport.minX,"ballTop":viewport.maxY-ballFrame.maxY,"ballSize":ballFrame.width]
    }
}

final class PetDisplayPreferences {
    static let minimumWidth = 220.0, maximumWidth = 720.0
    private let defaults: UserDefaults
    private(set) var mode: String
    private(set) var width: Double
    private var beforeResize: Double?
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        mode = defaults.string(forKey: "petDisplay.mode") == "half" ? "half" : "full"
        let value = defaults.object(forKey: "petDisplay.width") as? Double ?? 360
        width = value.isFinite ? min(Self.maximumWidth, max(Self.minimumWidth, value)) : 360
    }
    func setMode(_ value: String) {
        guard ["full", "half"].contains(value) else { return }
        resize("cancel", width: nil)
        mode = value; defaults.set(mode, forKey: "petDisplay.mode")
    }
    func resize(_ phase: String, width value: Double?) {
        if phase == "begin" { if beforeResize == nil { beforeResize = width }; return }
        guard let original = beforeResize else { return }
        if phase == "cancel" { width = original; beforeResize = nil; return }
        guard ["update", "commit"].contains(phase), let value, value.isFinite else { return }
        width = min(Self.maximumWidth, max(Self.minimumWidth, value))
        if phase == "commit" { defaults.set(width, forKey: "petDisplay.width"); beforeResize = nil }
    }
}
