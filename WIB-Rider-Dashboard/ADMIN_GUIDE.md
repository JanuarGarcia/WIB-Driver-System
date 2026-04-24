# WIB Rider Dashboard System

## Complete Admin Manual

### A. System Overview

#### What is the WIB Rider Dashboard?

The WIB Rider Dashboard is the admin control center for managing riders, deliveries, and order activity in real time.

Admins use it to:

- Assign riders
- Track deliveries on the map
- Monitor task progress
- Handle failed, cancelled, or problem orders

#### Main Purpose

- Make sure deliveries are assigned and completed
- Track riders live on the map
- Handle failed or cancelled orders
- Monitor system activity

#### Who Uses It?

- Admin
- Dispatcher

### B. Access and Login

#### Before You Start

You must have:

- An admin account
- Internet connection
- Dashboard link

#### Step-by-Step Login

1. Open your browser. Chrome is recommended.
2. Go to `https://rider-dashboard.wheninbaguioeat.com`
3. Enter your email and password.
4. Click `Login`.

#### If Login Fails

| Problem | What to Do |
| --- | --- |
| Wrong password | Re-type carefully |
| Account locked | Wait or contact IT |
| Page not loading | Refresh the page or check internet |

Warning: Too many wrong attempts can lock your account.

#### Logout

1. Click the drawer at the top-left.
2. Click `Logout`.

### C. Dashboard Home

#### Main Parts You Must Know

1. Map Panel
   Shows riders, merchants, and tasks.
2. Task Panel
   Tabs: `Unassigned`, `Assigned`, `Completed`, `Problem`
3. Agent Panel
   Shows riders and their `Online`, `Offline`, or `Active` status.
4. Notifications
   Shows dashboard alerts and system updates.
5. Scheduled Orders
   Shows future deliveries.

### D. Map Legend

#### Where to Find It

- Go to the bottom of the map.
- Click `Map legend`.

#### Marker Meaning

| Marker | Meaning |
| --- | --- |
| Blue | Active rider with live GPS |
| Purple | Merchant pickup point |
| Orange | Open delivery task |
| Fuchsia | Mangan or ErrandWib order |

#### How to Use It

- Click `Map legend` to open it.
- Click `Hide` to close it.
- The dashboard remembers your choice using `wib_map_legend_hidden`.

#### Optional: View Queue

- Use the queue button above the legend.
- This opens the rider queue and shows waiting riders.

### E. Settings Guide

#### Where to Open Settings

1. Open the left sidebar.
2. Click `Settings`.
3. Use the tabs at the top of the page.

#### Important Settings for Admins

##### 1. Show Notification Popup

Location:

- `Settings`
- `General`
- `Show Notification Popup`

What it does:

- Turns dashboard notification pop-ups on or off for the admin dashboard.
- When ON, alert pop-ups can appear in the dashboard while you work.
- When OFF, those pop-up alerts are hidden.

When to use it:

- Turn ON if you want immediate visual alerts.
- Turn OFF if pop-ups are too distracting during dispatching.

##### 2. Register Button Toggle for the WIB Rider App

Location:

- `Settings`
- `General`
- `Enabled Signup`

What it does:

- Controls whether the WIB Rider app shows the `Register` button.
- When ON, riders can see the `Register` button and submit new signup requests.
- When OFF, the rider app hides the `Register` button.

Important note:

- This setting affects rider account registration in `mt_driver`.
- This is an app-level setting, not a single-task setting.

##### 3. Rider Registration Defaults

Location:

- `Settings`
- `General`
- `Rider Registration`

Options:

- `Set Signup Status`
- `Signup - Send Notification Email To`

What it does:

- Sets the default `mt_driver.status` for new rider signups.
- Lets admins receive email notification for new rider registration.

##### 4. Merchant Logos on Dashboard Map

Location:

- `Settings`
- `Map settings`
- `Merchant logos on dashboard map`

What it does:

- Controls whether merchant pins on the dashboard map show each store's logo.
- When ON, merchant pins can display the merchant logo.
- When OFF, the map uses the standard merchant pin instead of store-specific logos.

Important note:

- This applies when the dashboard uses `Mapbox`.
- Google Maps uses the same store-style pin and does not use per-merchant logos.
- This setting is saved for the current browser after clicking `Save`.

When to use it:

- Turn ON if you want faster merchant recognition on the map.
- Turn OFF if you prefer a cleaner, more uniform map view.

##### 5. Dashboard Map - Merchant Filter

Location:

- `Settings`
- `Map settings`
- `Dashboard map - merchant filter`

What it does:

- Limits which merchant pins and related task pins appear on the dashboard map.
- Lets admins focus only on selected stores.
- Helps reduce map clutter when many merchants are active at the same time.

How to use it:

1. Open the merchant filter field.
2. Search for a merchant name.
3. Click the merchant to add it to the filter.
4. Repeat for other merchants as needed.
5. Click `Save` to apply the filter.

Tips:

- Use `Clear all` to remove all selected merchants.
- This is useful for dispatchers assigned to specific stores or groups of stores.

### F. Feature-by-Feature Guide

#### 1. Assign Task

Steps:

1. Open `Unassigned`.
2. Click the task.
3. Click `Assign Driver`.
4. Select a rider.

Important check:

- The rider must not be blocked by Office Compliance.

#### 2. Monitor Rider

Steps:

1. Use the map.
2. Click the rider.
3. Check movement and current position.

#### 3. Handle Rider Actions with Reason

When a rider:

- Cancels
- Fails
- Declines
- Drops or unassigns a task

The system requires a reason.

What Admin Should Do:

1. Open the task.
2. Check the rider reason.
3. Decide whether to reassign or escalate.

Example:

- Rider says: `Customer unreachable`
- Admin may reassign the task after checking the situation

#### 4. Proof Photo Handling

While task is active:

- Rider can upload proof
- Rider can replace proof
- Rider can delete proof

After task is finished:

- Proof is locked

Important:

- If proof is missing after completion, it can no longer be edited.
- This is expected system behavior.

#### 5. Task Status Handling

Steps:

1. Open task details.
2. Click `Change Status`.
3. Confirm before saving.

Reminder:

- Do not override task status without confirmation.

### G. Office Compliance

#### What It Is

Office Compliance is a rider account rule that may require a rider to report to the office before working.

#### What Happens If the Rider Is Not Compliant

- Rider cannot accept tasks
- Rider may not continue tasks
- The system can block rider actions

Important:

- This is not a task problem.
- It is a rider account restriction.

### H. Rider Reason

#### What It Is

A required explanation when a rider:

- Cancels
- Fails
- Declines
- Drops a task

#### Rules

- Must be 5 to 2000 characters
- Saved in system history
- Visible in the admin dashboard

Why it matters:

- It helps admins understand what went wrong before reassigning or escalating.

### I. Proof Photos

#### What Riders Upload

- Proof of Receipt
- Proof of Delivery

#### Edit Rules

| Situation | Can Edit Proof? |
| --- | --- |
| Task ongoing | Yes |
| Task finished | No |

Once a task is:

- Delivered
- Cancelled
- Failed
- Declined

The proofs are locked.

### J. Core Workflows

#### Workflow 1: Assign Task Properly

1. Check task details.
2. Check the map.
3. Check rider status.
4. Check Office Compliance.
5. Assign rider.

#### Workflow 2: Handle Failed Task with Reason

1. Open `Problem`.
2. Check rider reason.
3. Confirm the issue.
4. Reassign or escalate.

#### Workflow 3: Proof Verification

1. Open task details.
2. Check proof photos.
3. Confirm they are valid before closing the task.

### K. Error Handling

#### Common Issues

| Issue | Meaning | Fix |
| --- | --- | --- |
| Cannot assign rider | Rider blocked | Check Office Compliance |
| Missing proof | Not uploaded | Check task state |
| Proof cannot edit | Task finished | Expected behavior |
| No reason shown | Rider did not submit | Check API or logs |

#### When to Escalate

- API is not working at `/driver/api`
- Proof is not saving during active task
- Rider reason is not captured

Note:

- Rider mobile app actions come from `/driver/api`.

### L. Security and Best Practices

#### Do

- Always check rider reason
- Verify proof before closing tasks
- Monitor Office Compliance status
- Review important settings before changing them

#### Do Not

- Ignore compliance restrictions
- Edit completed tasks blindly
- Assume missing proof is always a bug
- Turn on rider app registration unless you are ready to receive signups

### M. Admin Checklist

#### Daily

- Assign tasks
- Check rider compliance
- Monitor problem tasks
- Confirm notification popup setting matches dispatcher preference
- Review map filter if dispatching is limited to selected merchants

#### Weekly

- Review rider behavior and reasons
- Check failed-task trends
- Verify rider app signup availability if registration is open

#### Monthly

- Audit system usage
- Report issues
- Review settings and registration workflow

### N. Quick Cheat Sheet

| Task | Action |
| --- | --- |
| Assign rider | Task -> Assign |
| Check rider reason | Task -> History |
| Check proof | Task details |
| Turn pop-up alerts on or off | Settings -> General -> Show Notification Popup |
| Show or hide rider app Register button | Settings -> General -> Enabled Signup |
| Show merchant logos on map | Settings -> Map settings -> Merchant logos on dashboard map |
| Limit visible merchants on map | Settings -> Map settings -> Dashboard map - merchant filter |

### O. FAQ

#### 1. Why can’t I assign a rider?

The rider may be under Office Compliance restriction.

#### 2. What is rider reason?

It is the rider’s explanation when they cancel, fail, decline, or drop a task.

#### 3. Why is proof locked?

The task is already finished.

#### 4. Can a rider edit proof after delivery?

No.

#### 5. Where do reasons come from?

They come from the rider mobile app through `/driver/api`.

#### 6. Is Office Compliance related to a task?

No. It is an account-level rule.

#### 7. What if reason is missing?

Check the system logs, API behavior, or report it.

#### 8. What if proof is wrong?

It must be corrected before task completion.

#### 9. What does Show Notification Popup control?

It controls whether dashboard pop-up alerts are shown to the admin user.

#### 10. What does Enabled Signup control?

It controls whether the WIB Rider app shows the `Register` button for new rider signup.

#### 11. What does Merchant logos on dashboard map control?

It controls whether merchant pins show store logos on the dashboard map, mainly when using `Mapbox`.

#### 12. What does Dashboard map - merchant filter control?

It controls which merchants appear on the dashboard map so admins can focus only on selected stores.
