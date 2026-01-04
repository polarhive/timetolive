// Login functionality
let userCredentials = null; // Store credentials after login
let comparisonData = null; // Store comparison data for overlay

// Helper function to generate consistent filename format: ec_23_6F
function generateTimetableFilename(srn, meta, includeExtension = false) {
    // Determine campus prefix: rr for PES1, ec for PES2
    let campusPrefix = 'ec'; // Default
    if (srn.startsWith('PES1')) {
        campusPrefix = 'rr';
    } else if (srn.startsWith('PES2')) {
        campusPrefix = 'ec';
    }

    // Extract semester number from "Sem-6" -> "6"
    let semester = '';
    if (meta['Class Name']) {
        const className = meta['Class Name'];
        const semMatch = className.match(/Sem-(\d+)/);
        if (semMatch) {
            semester = semMatch[1];
        }
    }

    // Extract section letter from "Section A" -> "A"
    const section = meta.Section;
    const sectionLetter = section ? section.replace(/Section\s+/i, '').trim() : '';

    // Determine year based on semester: sem6 = 23, sem4 = 24, etc.
    let year = '23'; // Default
    if (semester) {
        const semNum = parseInt(semester);
        if (semNum === 6) {
            year = '23';
        } else if (semNum === 4) {
            year = '24';
        } else if (semNum === 8) {
            year = '22';
        } // Add more mappings as needed
    }

    // Extract department from SRN (e.g. PES2UG23CS123 -> CS)
    let dept = '';
    try {
        const srnUp = srn ? srn.toUpperCase() : '';
        const m = srnUp.match(/PES[12]UG\d{2}([A-Z]{2,3})\d+/);
        if (m) dept = m[1].toLowerCase();
    } catch (e) { dept = ''; }

    // New frontend filename format: campus_yeardept_semsection (e.g. ec_23cs_6A)
    const baseName = dept ? `${campusPrefix}_${year}${dept}_${semester}${sectionLetter}` : `${campusPrefix}_${year}_${semester}${sectionLetter}`;
    return includeExtension ? `${baseName}.json` : baseName;
}

document.addEventListener('DOMContentLoaded', function () {
    const loginForm = document.getElementById('login-form');
    const mainApp = document.getElementById('main-app');
    const loginContainer = document.getElementById('login');

    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    function showLogin() {
        if (loginContainer) loginContainer.style.display = 'flex';
        if (mainApp) mainApp.style.display = 'none';
    }

    function showMainApp() {
        if (loginContainer) loginContainer.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';
        // Initialize the timetable app
        initTimetableApp();
    }

    // Check if already logged in from localStorage
    try {
        const savedCreds = localStorage.getItem('timetable.credentials');
        if (savedCreds) {
            userCredentials = JSON.parse(savedCreds);
            showMainApp();
        } else {
            showLogin();
        }
    } catch (e) {
        showLogin();
    }

    if (loginForm) {
        loginForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const srnEl = document.getElementById('srn');
            const passwordEl = document.getElementById('password');
            const srn = srnEl.value;
            const password = passwordEl.value;
            const submitBtn = loginForm.querySelector('button[type="submit"]');
            const origBtnText = submitBtn.innerHTML;

            // Show loading state
            submitBtn.disabled = true;
            srnEl.disabled = true;
            passwordEl.disabled = true;
            submitBtn.innerHTML = 'Logging in <span class="spinner" aria-hidden="true"></span>';
            submitBtn.setAttribute('aria-busy', 'true');

            try {
                // Use the semantic endpoint: fetch, save and dispatch are handled by /api/timetable
                console.info('Logging in via /api/timetable for semantic save/dispatch behavior');
                const response = await fetch('/api/timetable', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ srn, password })
                });

                if (response.ok) {
                    const data = await response.json();
                    // Store credentials in localStorage
                    userCredentials = { srn, password };
                    localStorage.setItem('timetable.credentials', JSON.stringify(userCredentials));
                    // Store timetable in localStorage
                    localStorage.setItem('timetable.data', JSON.stringify(data));
                    showMainApp();
                    return;
                } else {
                    const err = await response.json().catch(() => null);
                    alert('Login failed. ' + (err && err.error ? err.error : 'Please check your credentials.'));
                }
            } catch (error) {
                alert('Error during login: ' + error.message);
            } finally {
                // Restore button / inputs unless we've navigated away
                submitBtn.disabled = false;
                srnEl.disabled = false;
                passwordEl.disabled = false;
                submitBtn.innerHTML = origBtnText;
                submitBtn.removeAttribute('aria-busy');
            }
        });
    }
});

// UI preferences and helpers (top-level so both render and controls can access)
let UI_PREFS;

function loadPref(key, fallback) {
    try {
        const v = localStorage.getItem('timetable.' + key);
        return v === null ? fallback : JSON.parse(v);
    } catch (e) {
        return fallback;
    }
}

function savePref(key, val) {
    try { localStorage.setItem('timetable.' + key, JSON.stringify(val)); } catch (e) { }
}

// Helper to restore main timetable view after comparison or other overlays
function backToMyTimetable() {
    comparisonData = null;
    if (window._lastTimetableData) {
        const content = document.getElementById('content');
        if (content) {
            content.innerHTML = renderTimetable(window._lastTimetableData);
            initPrefControls();
            attachTimetableButtonListeners();
            applyFilters();
        }
    }
}

// Attach event listeners to export/compare buttons
function attachTimetableButtonListeners() {
    const compareBtn = document.getElementById('compare-btn');
    if (compareBtn) {
        // Clone and replace to remove all old event listeners
        const newCompareBtn = compareBtn.cloneNode(true);
        compareBtn.parentNode.replaceChild(newCompareBtn, compareBtn);
        newCompareBtn.addEventListener('click', () => {
            showCompareDialog();
        });
    }


    const exportIcalBtn = document.getElementById('export-ical');
    if (exportIcalBtn) {
        exportIcalBtn.addEventListener('click', () => {
            if (!userCredentials || !userCredentials.srn || !window._lastTimetableData || !window._lastTimetableData.meta) {
                alert('Please login to export your timetable as ICS.');
                return;
            }
            // Generate the timetable filename and open the API endpoint directly
            const filename = generateTimetableFilename(userCredentials.srn, window._lastTimetableData.meta, false);
            window.open(`/api/timetable/${filename}/ical`, '_blank');
        });
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            // Clear localStorage
            localStorage.removeItem('timetable.credentials');
            localStorage.removeItem('timetable.data');
            userCredentials = null;
            // Reload page to show login
            window.location.reload();
        });
    }
}

function initPrefControls() {
    const t = document.getElementById('toggle-teachers');
    const b = document.getElementById('toggle-breaks');
    if (t) {
        if (loadPref('showTeachers', UI_PREFS.showTeachers)) t.classList.add('active');
        UI_PREFS.showTeachers = t.classList.contains('active');
        t.addEventListener('click', (ev) => {
            ev.target.classList.toggle('active');
            UI_PREFS.showTeachers = ev.target.classList.contains('active');
            savePref('showTeachers', UI_PREFS.showTeachers);
            applyFilters();
        });
    }
    if (b) {
        if (loadPref('showBreaks', UI_PREFS.showBreaks)) b.classList.add('active');
        UI_PREFS.showBreaks = b.classList.contains('active');
        // If no prior preference exists, persist the default so the break state is
        // explicitly stored (ensures 'show breaks' is ON by default on first load).
        if (localStorage.getItem('timetable.showBreaks') === null) {
            savePref('showBreaks', UI_PREFS.showBreaks);
        }
        b.addEventListener('click', (ev) => {
            ev.target.classList.toggle('active');
            UI_PREFS.showBreaks = ev.target.classList.contains('active');
            savePref('showBreaks', UI_PREFS.showBreaks);
            applyFilters();
        });
    }

    // Force hideEmpty ON (user-requested: no control and always enabled)
    savePref('hideEmpty', true);
    UI_PREFS.hideEmpty = true;

    // Attach event listeners to timetable buttons
    attachTimetableButtonListeners();

    applyFilters();
}

async function loadSampleTimetable(section) {
    try {
        const response = await fetch(`/static/sample_timetable_${section}.json`);
        if (response.ok) {
            const jsonData = await response.json();
            document.getElementById('friend-json').value = JSON.stringify(jsonData, null, 2);
        } else {
            alert('Failed to load sample timetable');
        }
    } catch (error) {
        alert('Error loading sample timetable: ' + error.message);
    }
}

function compareTimetables(tt1, tt2) {
    const comparison = {
        user1_meta: tt1.meta || {},
        user2_meta: tt2.meta || {},
        common_free_periods: [],
        schedule_comparison: []
    };

    const days1 = tt1.schedule || [];
    const days2 = tt2.schedule || [];

    for (let i = 0; i < days1.length; i++) {
        const day1 = days1[i];
        const dayComparison = {
            day: day1.day,
            free_periods: []
        };

        if (i < days2.length) {
            const day2 = days2[i];
            const slots1 = day1.slots || [];
            const slots2 = day2.slots || [];

            for (let j = 0; j < slots1.length; j++) {
                if (j < slots2.length) {
                    const slot1 = slots1[j];
                    const slot2 = slots2[j];
                    const cells1 = slot1.cells || [];
                    const cells2 = slot2.cells || [];

                    const isFree1 = cells1.length === 0;
                    const isFree2 = cells2.length === 0;

                    if (isFree1 && isFree2) {
                        dayComparison.free_periods.push({
                            slot: slot1.slot || {},
                            time: (slot1.slot || {}).label || ""
                        });
                    }
                }
            }
        }

        comparison.schedule_comparison.push(dayComparison);
    }

    // Flatten common free periods
    for (const day of comparison.schedule_comparison) {
        for (const period of day.free_periods) {
            comparison.common_free_periods.push({
                day: day.day,
                time: period.time,
                slot: period.slot
            });
        }
    }

    return comparison;
}

function showCompareDialog() {
    // Create modal dialog for selecting timetable to compare
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); display: flex; align-items: center;
        justify-content: center; z-index: 1000;
    `;

    modal.innerHTML = `
        <div style="background: white; padding: 2rem; border-radius: 8px; max-width: 500px; width: 90%;">
            <h3>Compare Timetables</h3>
            <p>Select two timetables to compare:</p>
            <form id="compare-form">
                <div style="margin: 0.5rem 0;">
                    <label for="your-timetable" style="display: block; margin-bottom: 0.25rem; font-weight: bold;">Your Timetable:</label>
                    <select id="your-timetable" required style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px;">
                        <option value="">Select your timetable...</option>
                    </select>
                </div>
                <div style="margin: 0.5rem 0;">
                    <label for="friend-timetable" style="display: block; margin-bottom: 0.25rem; font-weight: bold;">Friend's Timetable:</label>
                    <select id="friend-timetable" required style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px;">
                        <option value="">Select friend's timetable...</option>
                    </select>
                </div>
                <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                    <button type="submit" style="flex: 1; padding: 0.5rem;">Compare</button>
                    <button type="button" id="cancel-compare" style="flex: 1; padding: 0.5rem;">Cancel</button>
                </div>
            </form>
        </div>
    `;

    document.body.appendChild(modal);

    // Load available timetables into both dropdowns
    const yourSelector = modal.querySelector('#your-timetable');
    const friendSelector = modal.querySelector('#friend-timetable');

    fetch('/api/timetable/all')
        .then(res => res.json())
        .then(data => {
            // Simple dedupe & sort (like `ls /dir/*`) — use exact filenames from the directory
            const names = new Set();

            // Add current user's timetable as a special marker in "Your Timetable" and seed the set
            let currentFilename = null;
            if (window._ownTimetableData && window._ownTimetableData.meta) {
                const meta = window._ownTimetableData.meta;
                const className = meta['Class Name'] || '';
                const section = meta.Section || '';

                const semMatch = className.match(/Sem-(\d+)/);
                const semester = semMatch ? semMatch[1] : '';
                const sectionMatch = section.match(/Section\s+([A-Z])/i);
                const sectionLetter = sectionMatch ? sectionMatch[1] : '';

                if (semester && sectionLetter) {
                    const srn = userCredentials.srn;
                    const filename = generateTimetableFilename(srn, window._ownTimetableData.meta);
                    currentFilename = filename;

                    const displayName = `${filename} (Current)`;
                    const currentOption = document.createElement('option');
                    currentOption.value = `${filename}__current__`;
                    currentOption.textContent = displayName;
                    yourSelector.appendChild(currentOption);

                    names.add(filename);
                }
            }

            // Collect names from API and dedupe
            data.timetables.forEach(tt => names.add(tt.name));

            // Sort the names alphabetically (locale-aware)
            const sortedNames = Array.from(names).sort((a, b) => a.localeCompare(b));

            // Populate selectors (exclude the exact currentFilename from the 'your' dropdown because it has a special marker)
            sortedNames.forEach(name => {
                if (!(currentFilename && name === currentFilename)) {
                    const yourOption = document.createElement('option');
                    yourOption.value = name;
                    yourOption.textContent = name;
                    yourSelector.appendChild(yourOption);
                }
                const friendOption = document.createElement('option');
                friendOption.value = name;
                friendOption.textContent = name;
                friendSelector.appendChild(friendOption);
            });

            // Auto-select current timetable in "Your Timetable" dropdown
            if (window._ownTimetableData && window._ownTimetableData.meta) {
                const meta = window._ownTimetableData.meta;
                const className = meta['Class Name'] || '';
                const section = meta.Section || '';

                // Extract semester number (e.g., "Sem-6" -> "6")
                const semMatch = className.match(/Sem-(\d+)/);
                const semester = semMatch ? semMatch[1] : '';

                // Extract section letter (e.g., "Section A" -> "A")
                const sectionMatch = section.match(/Section\s+([A-Z])/i);
                const sectionLetter = sectionMatch ? sectionMatch[1] : '';

                // Try to construct expected filename (e.g., "ec_23_6F")
                let expectedName = '';
                if (semester && sectionLetter) {
                    const srn = userCredentials.srn;
                    expectedName = generateTimetableFilename(srn, window._ownTimetableData.meta);
                }

                // Try to match by constructed name with current marker first
                let matched = false;
                if (expectedName) {
                    const expectedCurrentValue = `${expectedName}__current__`;
                    for (let option of yourSelector.options) {
                        if (option.value === expectedCurrentValue) {
                            option.selected = true;
                            matched = true;
                            break;
                        }
                    }
                }

                // Fallback: match by section letter if constructed name didn't work
                if (!matched && sectionLetter) {
                    for (let option of yourSelector.options) {
                        if (option.value && option.value.toLowerCase().includes(sectionLetter.toLowerCase())) {
                            option.selected = true;
                            break;
                        }
                    }
                }
            }
        })
        .catch(err => {
            console.error('Error loading timetable list:', err);
            yourSelector.innerHTML = '<option value="">Error loading timetables</option>';
            friendSelector.innerHTML = '<option value="">Error loading timetables</option>';
        });

    const form = modal.querySelector('#compare-form');
    const cancelBtn = modal.querySelector('#cancel-compare');

    cancelBtn.addEventListener('click', () => {
        document.body.removeChild(modal);
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const yourTimetableName = document.getElementById('your-timetable').value;
        const friendTimetableName = document.getElementById('friend-timetable').value;

        if (!yourTimetableName || !friendTimetableName) {
            alert('Please select both timetables to compare.');
            return;
        }



        try {
            let yourData;

            // Check if "your timetable" is the current user's timetable
            if (yourTimetableName.includes('__current__')) {
                // Use the stored current timetable data
                yourData = window._ownTimetableData;
                if (!yourData) {
                    throw new Error('Current timetable data not available. Please reload the page.');
                }
            } else {
                // Load from API
                const yourResponse = await fetch(`/api/timetable/${yourTimetableName}`);
                if (!yourResponse.ok) {
                    throw new Error(`Failed to load your timetable: ${yourResponse.status}`);
                }
                yourData = await yourResponse.json();
            }

            // Load friend's timetable
            const friendResponse = await fetch(`/api/timetable/${friendTimetableName}`);
            if (!friendResponse.ok) {
                throw new Error(`Failed to load friend's timetable: ${friendResponse.status}`);
            }
            const friendData = await friendResponse.json();

            // Compare locally using the comparison function
            const compData = compareTimetables(yourData, friendData);
            comparisonData = compData; // Store globally for overlay
            document.body.removeChild(modal);

            // Store the "your" timetable as the current one and render with overlay
            window._lastTimetableData = yourData;
            const content = document.getElementById('content');
            if (content) {
                content.innerHTML = renderTimetable(yourData, compData);
                // Re-initialize controls and reattach button listeners after re-render
                initPrefControls();
                attachTimetableButtonListeners();
                applyFilters();
            }

        } catch (error) {
            alert('Invalid JSON or comparison failed: ' + error.message);
        }
    });
}

function compareTimetables(tt1, tt2) {
    const comparison = {
        user1_meta: tt1.meta || {},
        user2_meta: tt2.meta || {},
        common_free_periods: [],
        schedule_comparison: []
    };

    const days1 = tt1.schedule || [];
    const days2 = tt2.schedule || [];

    for (let i = 0; i < days1.length; i++) {
        const day1 = days1[i];
        const dayComparison = {
            day: day1.day,
            free_periods: []
        };

        if (i < days2.length) {
            const day2 = days2[i];
            const slots1 = day1.slots || [];
            const slots2 = day2.slots || [];

            for (let j = 0; j < slots1.length; j++) {
                if (j < slots2.length) {
                    const slot1 = slots1[j];
                    const slot2 = slots2[j];
                    const cells1 = slot1.cells || [];
                    const cells2 = slot2.cells || [];

                    const isFree1 = cells1.length === 0;
                    const isFree2 = cells2.length === 0;

                    if (isFree1 && isFree2) {
                        dayComparison.free_periods.push({
                            slot: slot1.slot || {},
                            time: convertLabelTo24((slot1.slot || {}).label || "")
                        });
                    }
                }
            }
        }

        comparison.schedule_comparison.push(dayComparison);
    }

    // Flatten common free periods
    for (const day of comparison.schedule_comparison) {
        for (const period of day.free_periods) {
            comparison.common_free_periods.push({
                day: day.day,
                time: period.time,
                slot: period.slot
            });
        }
    }

    return comparison;
}

function renderOverlayTimetable(data) {
    const tt1 = { meta: data.user1_meta, schedule: [] };
    const tt2 = { meta: data.user2_meta, schedule: [] };

    // Reconstruct full timetable data from comparison
    // This is a bit hacky but necessary since we only have comparison data
    // In a real implementation, we'd pass the full timetables

    // For now, let's create a mock overlay based on the comparison data
    // We'll need to modify the comparison function to include full slot data

    let html = '<div class="overlay-timetable">';
    html += '<h3>Overlay View: Your Timetable vs Friend\'s Timetable</h3>';
    html += '<div class="legend" style="margin: 1rem 0; padding: 1rem; background: #f8f9fa; border-radius: 8px;">';
    html += '<div style="display: flex; gap: 1rem; flex-wrap: wrap;">';
    html += '<div style="display: flex; align-items: center; gap: 0.5rem;"><div style="width: 20px; height: 20px; background: #d4edda; border: 1px solid #c3e6cb;"></div><span>Both Free (Bunk! 🎉)</span></div>';
    html += '<div style="display: flex; align-items: center; gap: 0.5rem;"><div style="width: 20px; height: 20px; background: #fff3cd; border: 1px solid #ffeaa7;"></div><span>One Has Class</span></div>';
    html += '<div style="display: flex; align-items: center; gap: 0.5rem;"><div style="width: 20px; height: 20px; background: #f8d7da; border: 1px solid #f5c6cb;"></div><span>Both Have Class</span></div>';
    html += '<div style="display: flex; align-items: center; gap: 0.5rem;"><div style="width: 20px; height: 20px; background: #e2e3e5; border: 1px solid #d6d8db;"></div><span>Break/Empty</span></div>';
    html += '</div>';
    html += '</div>';

    // Create overlay table
    html += '<div class="table-wrap">';
    html += '<table class="frametimetable overlay-table">';

    // Get all days from comparison
    const days = data.schedule_comparison || [];

    // Get all time slots from the first day
    const firstDay = days[0];
    const timeSlots = firstDay ? firstDay.slots || [] : [];

    // Header
    html += '<thead><tr><th class="day-col">Time</th>';
    days.forEach(day => {
        html += `<th class="day-col">${shortenDay(day.day)}</th>`;
    });
    html += '</tr></thead>';

    // Body
    html += '<tbody>';
    timeSlots.forEach((slot, slotIndex) => {
        const timeLabel = slot.slot ? convertLabelTo24(slot.slot.label) : '';
        html += `<tr><td class="time-col">${timeLabel}</td>`;

        days.forEach(day => {
            const daySlots = day.slots || [];
            const daySlot = daySlots[slotIndex];

            if (!daySlot) {
                html += '<td class="overlay-cell break-cell">-</td>';
                return;
            }

            const cells1 = daySlot.cells1 || [];
            const cells2 = daySlot.cells2 || [];
            const isFree1 = cells1.length === 0;
            const isFree2 = cells2.length === 0;

            let cellClass = '';
            let cellContent = '';

            if (isFree1 && isFree2) {
                // Both free - great for bunking!
                cellClass = 'both-free';
                cellContent = '🎉';
            } else if (isFree1 && !isFree2) {
                // Only friend has class
                cellClass = 'friend-class';
                cellContent = cells2.map(c => c.code || c.subject.split('-')[0]).join(', ');
            } else if (!isFree1 && isFree2) {
                // Only you have class
                cellClass = 'your-class';
                cellContent = cells1.map(c => c.code || c.subject.split('-')[0]).join(', ');
            } else {
                // Both have class
                cellClass = 'both-class';
                const yourSubjects = cells1.map(c => c.code || c.subject.split('-')[0]);
                const friendSubjects = cells2.map(c => c.code || c.subject.split('-')[0]);
                cellContent = `${yourSubjects.join(', ')} | ${friendSubjects.join(', ')}`;
            }

            html += `<td class="overlay-cell ${cellClass}">${cellContent}</td>`;
        });

        html += '</tr>';
    });

    html += '</tbody></table>';
    html += '</div>';

    // Add some CSS for the overlay table
    html += '<style>';
    html += '.overlay-table .time-col { font-weight: bold; background: #f8f9fa; }';
    html += '.overlay-cell { padding: 0.5rem; text-align: center; border: 1px solid #dee2e6; }';
    html += '.overlay-cell.both-free { background: #d4edda; color: #155724; }';
    html += '.overlay-cell.friend-class { background: #fff3cd; color: #856404; }';
    html += '.overlay-cell.your-class { background: #cce5ff; color: #004085; }';
    html += '.overlay-cell.both-class { background: #f8d7da; color: #721c24; font-size: 0.8em; }';
    html += '.overlay-cell.break-cell { background: #e2e3e5; color: #383d41; }';
    html += '.control-button.active { background: #007bff; color: white; }';
    html += '</style>';

    html += '</div>';

    return html;
}
function renderComparison(data) {
    const content = document.getElementById('content');
    if (!content) return;

    let html = '<div class="comparison-view">';
    html += '<h2>Common Free Periods (Bunk Together! 🎉)</h2>';

    // Show metadata
    html += '<div class="comparison-meta" style="display: flex; gap: 2rem; margin: 1rem 0; font-size: 0.9em; color: #666;">';
    html += `<div><strong>You:</strong> ${data.user1_meta.Section || 'Unknown'} (${data.user1_meta['Class Name'] || 'Unknown'})</div>`;
    html += `<div><strong>Friend:</strong> ${data.user2_meta.Section || 'Unknown'} (${data.user2_meta['Class Name'] || 'Unknown'})</div>`;
    html += '</div>';

    if (data.common_free_periods && data.common_free_periods.length > 0) {
        // Group by day and show free periods
        const groupedByDay = {};
        data.common_free_periods.forEach(period => {
            if (!groupedByDay[period.day]) groupedByDay[period.day] = [];
            groupedByDay[period.day].push(period.time);
        });

        html += '<div class="free-periods-summary" style="background: #e8f5e8; padding: 1.5rem; border-radius: 8px; margin: 1rem 0;">';
        Object.keys(groupedByDay).forEach(day => {
            html += `<div style="margin: 1rem 0; padding: 0.5rem; background: white; border-radius: 4px;">`;
            html += `<strong style="color: #2d5a2d;">${day}:</strong> `;
            html += `<span style="font-family: monospace; color: #155724;">${groupedByDay[day].join(', ')}</span>`;
            html += '</div>';
        });
        html += '</div>';
    } else {
        html += '<div style="background: #f8d7da; color: #721c24; padding: 1rem; border-radius: 8px; margin: 1rem 0;">';
        html += '<p style="margin: 0;">😔 No common free periods found this week.</p>';
        html += '<p style="margin: 0.5rem 0 0 0; font-size: 0.9em;">Try comparing with someone who has a different schedule!</p>';
        html += '</div>';
    }

    // Show detailed comparison by day
    html += '<h3 style="margin-top: 2rem;">Detailed Comparison</h3>';
    html += '<div class="detailed-comparison">';
    data.schedule_comparison.forEach(day => {
        html += `<div class="day-comparison" style="margin: 1rem 0; padding: 1rem; border: 1px solid #ddd; border-radius: 8px;">`;
        html += `<h4 style="margin: 0 0 0.5rem 0; color: #495057;">${day.day}</h4>`;
        if (day.free_periods && day.free_periods.length > 0) {
            html += '<div style="background: #fff3cd; padding: 0.5rem; border-radius: 4px; margin: 0.5rem 0;">';
            html += `<strong>Free together:</strong> ${day.free_periods.map(p => p.time).join(', ')}`;
            html += '</div>';
        } else {
            html += '<p style="color: #666; margin: 0.5rem 0;">No common free periods on this day.</p>';
        }
        html += '</div>';
    });
    html += '</div>';

    // Back button
    html += '<div style="margin-top: 2rem;">';
    html += '<button onclick="backToMyTimetable()" style="padding: 0.5rem 1rem; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">Back to My Timetable</button>';
    html += '</div>';

    html += '</div>';

    content.innerHTML = html;
}

function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Convert 12-hour time tokens with AM/PM to 24-hour hh:mm. If AM/PM missing,
// assume the token is already in 24-hour format and leave it unchanged.
function convertTimeToken(timeStr, ampm) {
    const parts = timeStr.split(':');
    if (parts.length !== 2) return timeStr;
    let h = parseInt(parts[0], 10);
    const m = parts[1];
    if (ampm) {
        const a = String(ampm).toLowerCase();
        if (a === 'pm' && h < 12) h += 12;
        if (a === 'am' && h === 12) h = 0;
    }
    return `${String(h).padStart(2, '0')}:${m}`;
}

// Replace any occurrences like '08:45 AM' or '8:45pm' in a label with 24-hour times
function convertLabelTo24(label) {
    if (!label) return label;
    return label.replace(/(\d{1,2}:\d{2})\s*(AM|PM|am|pm)?/g, (m, time, ampm) => {
        return convertTimeToken(time, ampm);
    });
}

function shortenDay(day) {
    const map = {
        'Monday': 'M',
        'Tuesday': 'T',
        'Wednesday': 'W',
        'Thursday': 'H',
        'Friday': 'F',
        'Saturday': 'S',
        'Sunday': 'U'
    };
    return map[day] || day;
}

// Update document classes to match the theme (used by flexoki utilities)
function updateThemeClass() {
    // Force light by default; dark mode disabled
    const t = document.documentElement.dataset.theme || 'light';
    if (t === 'dark') {
        document.documentElement.classList.add('theme-dark');
        document.documentElement.classList.remove('theme-light');
    } else {
        document.documentElement.classList.add('theme-light');
        document.documentElement.classList.remove('theme-dark');
    }
}

// Map subjects to a fixed Material UI palette so colors are consistent and
// predictable. Picks an index deterministically from the code string and
// selects a light (or dark) tint depending on current theme.
function colorForCode(code) {
    if (!code) return '';
    // Simple deterministic hash
    let h = 0;
    for (let i = 0; i < code.length; i++) {
        h = (h * 31 + code.charCodeAt(i)) >>> 0;
    }

    // Flexoki color groups
    const GROUPS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta'];
    const g = GROUPS[h % GROUPS.length];
    const themeIsDark = document.documentElement && document.documentElement.dataset && document.documentElement.dataset.theme === 'dark';

    // Light theme: use very soft background (50) and group border color (400)
    // Dark theme: use deep background (800) and group border color (600)
    const bg = themeIsDark ? `var(--flexoki-${g}-800)` : `var(--flexoki-${g}-50)`;
    const border = themeIsDark ? `var(--flexoki-${g}-600)` : `var(--flexoki-${g}-400)`;
    // Ensure text uses theme text color for contrast
    return `background-color: ${bg}; border: 1px solid ${border}; box-shadow: none; color: var(--color-tx-normal);`;
}



function renderControls() {
    const headerRight = document.getElementById('header-right') || document.querySelector('header');
    if (!headerRight) return;
    // create a container for controls; keep it accessible by id for tests
    let c = document.getElementById('controls');
    if (!c) {
        c = document.createElement('div');
        c.id = 'controls';
        c.style.display = 'flex';
        c.style.alignItems = 'center';
        c.style.gap = '1.2rem';
        headerRight.appendChild(c);
    }
    c.innerHTML = `
        <button id="toggle-teachers" class="control-button">Show Names</button>
        <button id="toggle-breaks" class="control-button">Show breaks</button>
        <button id="logout-btn" class="control-button" style="margin-left: auto;">Refresh</button>
    `;

    // Apply the theme class once on render (we keep default theme behavior but no toggle UI)
    if (window.updateThemeClass) window.updateThemeClass();
}

function applyFilters() {
    // Show teachers: toggle a class so hover can reveal teachers even when
    // the global "Show teachers" option is off.
    if (UI_PREFS.showTeachers) {
        document.documentElement.classList.add('show-teachers');
    } else {
        document.documentElement.classList.remove('show-teachers');
    }

    // Show breaks
    const breaks = document.querySelectorAll('.break-slot');
    breaks.forEach(b => b.style.display = UI_PREFS.showBreaks ? '' : 'none');

    // Hide empty columns: use precomputed data-group-empty attributes
    const empties = document.querySelectorAll('.frametimetable [data-group-empty="true"]');
    if (UI_PREFS.hideEmpty) {
        empties.forEach(e => {
            const isBreak = e.classList && e.classList.contains('break-slot');
            if (isBreak) {
                // honor showBreaks preference: if breaks are shown, keep visible; otherwise hide
                e.style.display = UI_PREFS.showBreaks ? '' : 'none';
            } else {
                e.style.display = 'none';
            }
        });
    } else {
        empties.forEach(e => e.style.display = '');
    }
}

function renderTimetable(data, comparisonData = null) {
    if (!data || !data.schedule || (!data.schedule.length && !data.meta)) {
        return '<h1>No timetable data available</h1><p>Check the API endpoint for raw JSON.</p>';
    }

    // Helper functions
    function isBreakSlot(slot) {
        const s = slot.slot || {};
        return (s.status === 1) || (String(s.label || '').toLowerCase().includes('break'));
    }

    function getSlotCode(slot) {
        const cells = slot.cells || [];
        if (!cells.length) return '';
        const c = cells[0];
        return c.code || (c.subject ? c.subject.split('-')[0] : '');
    }

    function getElectiveGroup(code) {
        const match = code.match(/UE\d+CS\d+(AA|AB|BA|BB)\d+/);
        if (!match) return null;
        const type = match[1];
        const groups = { AA: 'E1', AB: 'E2', BA: 'E3', BB: 'E4' };
        return groups[type] || null;
    }

    function isCommonFreePeriod(dayName, timeLabel) {
        if (!comparisonData || !comparisonData.common_free_periods) return false;
        return comparisonData.common_free_periods.some(period =>
            period.day === dayName && period.time === timeLabel
        );
    }

    // Styles have been extracted to `static/styles.css`; index.html should include it
    let html = '';



    // Render metadata: compute compact "6F @ 407" and inject as a heading above the table (not inside the table)
    let metaHeadingHtml = '';
    if (data.meta) {
        // Normalize keys for easier lookup
        const meta = {};
        for (const [k, v] of Object.entries(data.meta)) {
            meta[String(k).toLowerCase()] = v;
        }

        const classVal = meta['class name'] || meta['class'] || meta['classname'] || '';
        const sectionVal = meta['section'] || '';
        const roomVal = meta['room'] || '';

        // Extract numeric semester from class (e.g. "Sem-6" -> "6")
        let classNum = '';
        const m = String(classVal || '').match(/(\d+)/);
        if (m) classNum = m[1];

        // Extract trailing section code (e.g. "Section F" -> "F")
        let sectionCode = '';
        const m2 = String(sectionVal || '').match(/([A-Za-z0-9]+)\s*$/);
        if (m2) sectionCode = m2[1];

        const compactLabel = (classNum ? classNum : '') + (sectionCode ? sectionCode : '');

        // Try to extract numeric room number (e.g. "Main 407" -> "407")
        let roomNumber = '';
        const rm = String(roomVal || '').match(/(\d+)/);
        if (rm) roomNumber = rm[1];

        if (compactLabel || roomNumber || roomVal) {
            // Build a compact heading (no label, just values)
            const parts = [];
            if (compactLabel) parts.push(escapeHtml(compactLabel));
            if (roomNumber) parts.push(`@ ${escapeHtml(roomNumber)}`);
            else if (roomVal && !roomNumber) parts.push(`@ ${escapeHtml(roomVal)}`);
            metaHeadingHtml = `<div class="meta-heading">${parts.join(' ')}</div>`;
        }

        // Inject into document heading area (prefer right after the subtitle)
        try {
            const subtitleEl = document.querySelector('.title-wrap .subtitle');
            // Remove any existing meta-heading in the title area
            const existing = document.querySelector('.title-wrap .meta-heading');
            if (existing) existing.remove();
            if (metaHeadingHtml) {
                const d = document.createElement('div');
                d.className = 'meta-heading';
                d.innerHTML = metaHeadingHtml;
                if (subtitleEl && subtitleEl.parentNode) {
                    // Replace the subtitle paragraph with the compact meta heading
                    subtitleEl.replaceWith(d);
                } else {
                    // Fallback: append to title-wrap
                    const titleWrap = document.querySelector('.title-wrap');
                    if (titleWrap) titleWrap.appendChild(d);
                }
            }
        } catch (e) {
            // If DOM isn't available (e.g., server-side use), ignore
        }
    }

    // Build table
    const schedule = (data.schedule || []).filter(day => day.day !== 'Saturday');
    let allSlots = [];
    if (schedule.length > 0) {
        allSlots = schedule[0].slots || [];
    }

    // Always render each header slot separately (no grouping)
    const groupedHeaderSlots = allSlots.map(s => ({ slots: [s], colspan: 1, orderKeys: [(s.slot && s.slot.orderedBy) || null] }));

    // Ensure header -> body alignment: record orderedBy keys for each header group
    for (const g of groupedHeaderSlots) {
        g.orderKeys = (g.slots || []).map(s => (s.slot && s.slot.orderedBy) || null).filter(x => x !== null);
    }

    // Precompute whether each header group has content on any day. This lets us
    // mark 'empty' groups at render time so applyFilters can show/hide quickly.
    const colHasContent = new Array(groupedHeaderSlots.length).fill(false);
    const colLabels = new Array(groupedHeaderSlots.length).fill('');
    for (let gi = 0; gi < groupedHeaderSlots.length; gi++) {
        const group = groupedHeaderSlots[gi];
        // Compute label for this group
        const sl = group.slots[0];
        let label = '';
        if (group.colspan > 1) {
            const labels = (group.slots || []).map(s => (s.slot && s.slot.label) || '').filter(Boolean);
            // collect time tokens like HH:MM with optional AM/PM from all labels
            const times = [];
            const tokRe = /(\d{1,2}:\d{2})\s*(AM|PM|am|pm)?/g;
            for (const l of labels) {
                let m;
                while ((m = tokRe.exec(l)) !== null) {
                    // convert to 24h and push
                    times.push(convertTimeToken(m[1], m[2]));
                }
            }
            if (times.length >= 2) {
                // use first and last time found as the combined range
                label = `${times[0]} - ${times[times.length - 1]}`;
            } else {
                const unique = [...new Set(labels.map(convertLabelTo24))];
                label = unique.length === 1 ? (unique[0] || '') : unique.join(' / ');
            }
        } else {
            label = sl.slot ? convertLabelTo24(sl.slot.label) : '';
        }
        colLabels[gi] = label;

        for (const day of schedule) {
            const matchedSlots = (group.orderKeys || []).map(k => {
                return (day.slots || []).find(s => (s.slot && s.slot.orderedBy) === k) || { slot: {}, cells: [] };
            });
            const allCells = [];
            for (const ms of matchedSlots) allCells.push(...(ms.cells || []));
            if (allCells.length) { colHasContent[gi] = true; break; }
        }
    }

    html += '<div class="table-wrap">';
    html += '<table class="frametimetable">';
    // header
    html += '<thead><tr><th class="day-col">-</th>';
    for (let gi = 0; gi < groupedHeaderSlots.length; gi++) {
        const group = groupedHeaderSlots[gi];
        const label = colLabels[gi];
        const colspan = group.colspan > 1 ? ` colspan="${group.colspan}"` : '';
        const breakClass = group.slots.some(isBreakSlot) ? ' break-slot' : '';
        const emptyAttr = colHasContent[gi] ? '' : ' data-group-empty="true"';
        html += `<th${colspan} data-group-index="${gi}"${emptyAttr} class="slot-header${breakClass}">${escapeHtml(label)}</th>`;
    }
    html += '</tr></thead>';

    // body rows
    html += '<tbody>';
    for (const day of schedule) {
        html += `<tr><td class="day-col">${escapeHtml(shortenDay(day.day))}</td>`;
        // Use header grouping as the canonical layout and map day's slots into those groups
        for (let gi = 0; gi < groupedHeaderSlots.length; gi++) {
            const group = groupedHeaderSlots[gi];
            const colspan = group.colspan > 1 ? ` colspan="${group.colspan}"` : '';
            const breakClass = group.slots.some(isBreakSlot) ? ' break-slot' : '';
            const emptyAttr = colHasContent[gi] ? '' : ' data-group-empty="true"';

            // If this header group spans two slots but on THIS day those two slots
            // are not actually the same subject, we render two separate <td>s
            // instead of a single colspan so Friday (or any day) doesn't look
            // merged incorrectly.
            // Updated to check ALL cells in both slots for proper elective grouping
            function codesMatchOnThisDay(dayObj, aKey, bKey) {
                if (!aKey || !bKey) return false;
                const aSlot = (dayObj.slots || []).find(s => (s.slot && s.slot.orderedBy) === aKey);
                const bSlot = (dayObj.slots || []).find(s => (s.slot && s.slot.orderedBy) === bKey);
                if (!aSlot || !bSlot) return false;
                const aCells = aSlot.cells || [];
                const bCells = bSlot.cells || [];
                if (!aCells.length || !bCells.length) return false;

                // Get all codes/elective groups from both slots
                const aCodes = new Set();
                const bCodes = new Set();

                for (const cell of aCells) {
                    let code = cell.code || (cell.subject ? cell.subject.split('-')[0] : '');
                    const elective = getElectiveGroup(code);
                    if (elective) code = elective;
                    if (code) aCodes.add(code);
                }

                for (const cell of bCells) {
                    let code = cell.code || (cell.subject ? cell.subject.split('-')[0] : '');
                    const elective = getElectiveGroup(code);
                    if (elective) code = elective;
                    if (code) bCodes.add(code);
                }

                // Check if there's any common code between the two slots
                for (const aCode of aCodes) {
                    if (bCodes.has(aCode)) return true;
                }
                return false;
            }

            // If group has colspan and the two slots don't match on this day,
            // render them as two cells for this row instead of one merged cell.
            if (group.colspan > 1) {
                const aKey = (group.slots[0].slot && group.slots[0].slot.orderedBy) || null;
                const bKey = (group.slots[1].slot && group.slots[1].slot.orderedBy) || null;

                // Check if codes match on this specific day
                const shouldMerge = codesMatchOnThisDay(day, aKey, bKey);

                if (!shouldMerge) {
                    // Codes don't match - render each sub-slot as its own td (preserves alignment)
                    for (let si = 0; si < group.orderKeys.length; si++) {
                        const subKey = group.orderKeys[si];
                        const subMatchedSlot = (day.slots || []).find(s => (s.slot && s.slot.orderedBy) === subKey) || { slot: {}, cells: [] };

                        // Compute per-subslot attributes
                        const subBreakClass = isBreakSlot(subMatchedSlot) ? ' break-slot' : '';
                        const subHasContent = (subMatchedSlot.cells || []).length > 0;
                        const subEmptyAttr = subHasContent ? '' : ' data-group-empty="true"';
                        const subLabel = subMatchedSlot.slot ? convertLabelTo24(subMatchedSlot.slot.label) : '';

                        html += `<td data-group-index="${gi}"${subEmptyAttr} class="slot-cell${subBreakClass}" style="position: relative;">`;

                        const ms = subMatchedSlot;
                        const allCells = ms.cells || [];

                        // Dedup by code
                        const seenCodes = new Set();
                        const uniqueCells = [];
                        for (const c of allCells) {
                            const code = c.code || (c.subject ? c.subject.split('-')[0] : '');
                            if (!seenCodes.has(code)) {
                                seenCodes.add(code);
                                uniqueCells.push(c);
                            }
                        }

                        let hasContent = false;
                        if (uniqueCells.length === 2) {
                            const group1 = getElectiveGroup(uniqueCells[0].code);
                            const group2 = getElectiveGroup(uniqueCells[1].code);
                            if (group1 && group2 && group1 === group2) {
                                const electiveLabel = `${group1}`;
                                const style = colorForCode(uniqueCells[0].code || electiveLabel);
                                html += `<div class="sbj_row"${style ? ` style="${style}"` : ''} role="article" tabindex="0" aria-label="${electiveLabel}">`;
                                html += `<div class="subject"><strong>${escapeHtml(electiveLabel)}</strong></div>`;
                                html += '</div>';
                                hasContent = true;
                            } else {
                                for (const c of uniqueCells) {
                                    hasContent = true;
                                    const code = c.code || (c.subject ? c.subject.split('-')[0] : '');
                                    let subj = c.subject || '';
                                    const electiveLabel = getElectiveGroup(code);
                                    if (electiveLabel) subj = electiveLabel;
                                    else if (subjectMapping[code]) subj = subjectMapping[code];
                                    let facs = '';
                                    if (Array.isArray(c.faculties) && c.faculties.length) {
                                        const seen = new Set();
                                        const unique = [];
                                        for (const raw of c.faculties) {
                                            const n = String(raw || '').trim();
                                            const key = n.toLowerCase();
                                            if (!seen.has(key) && n) { seen.add(key); unique.push(n); }
                                        }
                                        facs = unique.join(', ');
                                    }
                                    const safeSubj = escapeHtml(subj);
                                    const safeFacs = escapeHtml(facs);
                                    const style = colorForCode(code);
                                    html += `<div class="sbj_row"${style ? ` style="${style}"` : ''} role="article" tabindex="0" aria-label="${safeSubj} - Faculties: ${safeFacs}">`;
                                    html += `<div class="subject"><strong>${safeSubj}</strong></div>`;
                                    if (facs) html += `<div class="faculty small">${safeFacs}</div>`;
                                    html += '</div>';
                                }
                            }
                        } else {
                            for (const c of uniqueCells) {
                                hasContent = true;
                                const code = c.code || (c.subject ? c.subject.split('-')[0] : '');
                                let subj = c.subject || '';
                                const electiveLabel = getElectiveGroup(code);
                                if (electiveLabel) subj = electiveLabel;
                                else if (subjectMapping[code]) subj = subjectMapping[code];
                                let facs = '';
                                if (Array.isArray(c.faculties) && c.faculties.length) {
                                    const seen = new Set();
                                    const unique = [];
                                    for (const raw of c.faculties) {
                                        const n = String(raw || '').trim();
                                        const key = n.toLowerCase();
                                        if (!seen.has(key) && n) { seen.add(key); unique.push(n); }
                                    }
                                    facs = unique.join(', ');
                                }
                                const safeSubj = escapeHtml(subj);
                                const safeFacs = escapeHtml(facs);
                                const style = colorForCode(code);
                                html += `<div class="sbj_row"${style ? ` style="${style}"` : ''} role="article" tabindex="0" aria-label="${safeSubj} - Faculties: ${safeFacs}">`;
                                html += `<div class="subject"><strong>${safeSubj}</strong></div>`;
                                if (facs) html += `<div class="faculty small">${safeFacs}</div>`;
                                html += '</div>';
                            }
                        }
                        if (!hasContent) html += '<span class="small">-</span>';

                        // Add overlay for common free periods (use per-subslot label)
                        if (comparisonData && isCommonFreePeriod(day.day, subLabel)) {
                            html += '<div class="free-overlay" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(40, 167, 69, 0.2); border: 2px solid #28a745; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #155724; font-weight: bold; font-size: 1.2em;"><img src="/static/rabbit.webp" alt="Free!" style="width: 24px; height: 24px;"></div>';
                        }

                        html += '</td>';
                    }
                    // Move to next header group
                    continue;
                }
                // If shouldMerge is true, fall through to default behavior to render merged cell
            }

            // Default behavior: render a single (possibly colspan'ed) cell for the group
            html += `<td${colspan} data-group-index="${gi}"${emptyAttr} class="slot-cell${breakClass}" style="position: relative;">`;
            let hasContent = false;

            // Match the header group's orderedBy keys into this day's slots (preserves alignment)
            const matchedSlots = (group.orderKeys || []).map(k => {
                return (day.slots || []).find(s => (s.slot && s.slot.orderedBy) === k) || { slot: {}, cells: [] };
            });

            const allCells = [];
            for (const ms of matchedSlots) {
                allCells.push(...(ms.cells || []));
            }

            // Dedup all cells in the group by code
            const seenCodes = new Set();
            const uniqueCells = [];
            for (const c of allCells) {
                const code = c.code || (c.subject ? c.subject.split('-')[0] : '');
                if (!seenCodes.has(code)) {
                    seenCodes.add(code);
                    uniqueCells.push(c);
                }
            }

            // Check if uniqueCells are 2 electives with same group
            if (uniqueCells.length === 2) {
                const group1 = getElectiveGroup(uniqueCells[0].code);
                const group2 = getElectiveGroup(uniqueCells[1].code);
                if (group1 && group2 && group1 === group2) {
                    // Show Elective X
                    const electiveLabel = `${group1}`;
                    const style = colorForCode(uniqueCells[0].code || electiveLabel);
                    html += `<div class="sbj_row"${style ? ` style="${style}"` : ''} role="article" tabindex="0" aria-label="${electiveLabel}">`;
                    html += `<div class="subject"><strong>${escapeHtml(electiveLabel)}</strong></div>`;
                    html += '</div>';
                    hasContent = true;
                } else {
                    // Render both
                    for (const c of uniqueCells) {
                        hasContent = true;
                        const code = c.code || (c.subject ? c.subject.split('-')[0] : '');
                        let subj = c.subject || '';
                        // If this is an elective matching UE...AA/AB/BA/BB pattern, prefer E1..E4 label
                        const electiveLabel = getElectiveGroup(code);
                        if (electiveLabel) {
                            subj = electiveLabel;
                        } else if (subjectMapping[code]) {
                            subj = subjectMapping[code];
                        }
                        // Deduplicate faculty names (case-insensitive) and preserve order
                        let facs = '';
                        if (Array.isArray(c.faculties) && c.faculties.length) {
                            const seen = new Set();
                            const unique = [];
                            for (const raw of c.faculties) {
                                const n = String(raw || '').trim();
                                const key = n.toLowerCase();
                                if (!seen.has(key) && n) {
                                    seen.add(key);
                                    unique.push(n);
                                }
                            }
                            facs = unique.join(', ');
                        }
                        const safeSubj = escapeHtml(subj);
                        const safeFacs = escapeHtml(facs);
                        const style = colorForCode(code);
                        html += `<div class="sbj_row"${style ? ` style="${style}"` : ''} role="article" tabindex="0" aria-label="${safeSubj} - Faculties: ${safeFacs}">`;
                        html += `<div class="subject"><strong>${safeSubj}</strong></div>`;
                        if (facs) {
                            html += `<div class="faculty small">${safeFacs}</div>`;
                        }
                        html += '</div>';
                    }
                }
            } else {
                // Render unique cells
                for (const c of uniqueCells) {
                    hasContent = true;
                    const code = c.code || (c.subject ? c.subject.split('-')[0] : '');
                    let subj = c.subject || '';
                    const electiveLabel = getElectiveGroup(code);
                    if (electiveLabel) {
                        subj = electiveLabel;
                    } else if (subjectMapping[code]) {
                        subj = subjectMapping[code];
                    }
                    // Deduplicate faculty names (case-insensitive) and preserve order
                    let facs = '';
                    if (Array.isArray(c.faculties) && c.faculties.length) {
                        const seen = new Set();
                        const unique = [];
                        for (const raw of c.faculties) {
                            const n = String(raw || '').trim();
                            const key = n.toLowerCase();
                            if (!seen.has(key) && n) {
                                seen.add(key);
                                unique.push(n);
                            }
                        }
                        facs = unique.join(', ');
                    }
                    const safeSubj = escapeHtml(subj);
                    const safeFacs = escapeHtml(facs);
                    const style = colorForCode(code);
                    html += `<div class="sbj_row"${style ? ` style="${style}"` : ''} role="article" tabindex="0" aria-label="${safeSubj} - Faculties: ${safeFacs}">`;
                    html += `<div class="subject"><strong>${safeSubj}</strong></div>`;
                    if (facs) {
                        html += `<div class="faculty small">${safeFacs}</div>`;
                    }
                    html += '</div>';
                }
            }
            if (!hasContent) {
                html += '<span class="small">-</span>';
            }

            // Add overlay for common free periods
            if (comparisonData && isCommonFreePeriod(day.day, colLabels[gi])) {
                html += '<div class="free-overlay" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(40, 167, 69, 0.2); border: 2px solid #28a745; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #155724; font-weight: bold; font-size: 1.2em;"><img src="/static/rabbit.webp" alt="Free!" style="width: 24px; height: 24px;"></div>';
            }

            html += '</td>';
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // Add action buttons after the table
    html += '<div style="display: flex; gap: 1rem; justify-content: flex-end; margin-top: 2rem; flex-wrap: wrap;">';
    if (comparisonData) {
        html += '<button id="back-to-my" onclick="backToMyTimetable()" style="padding: 0.75rem 1.5rem; background: #6c757d; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 1rem; font-weight: 500;">Back to My Timetable</button>';
    }
    html += '<button id="compare-btn" style="padding: 0.75rem 1.5rem; background: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 1rem; font-weight: 500;">Compare</button>';
    html += '<button id="export-ical" class="control-button" style="padding: 0.75rem 1.5rem; background: #28a745; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 1rem; font-weight: 500;">Add to Cal</button>';
    html += '</div>';

    return html;
}

let subjectMapping = {};

function initTimetableApp() {
    // UI preferences and helpers
    UI_PREFS = {
        showTeachers: loadPref('showTeachers', false),
        showBreaks: loadPref('showBreaks', true),
        // Default hideEmpty to true for first-time visitors
        hideEmpty: loadPref('hideEmpty', true),
    };

    // Force light theme: disable dark mode entirely
    document.documentElement.dataset.theme = 'light';
    if (window.updateThemeClass) window.updateThemeClass();

    // Ensure UI controls and containers exist
    renderControls();

    // Create loading and content elements if absent
    const app = document.querySelector('.app');
    if (app && !document.querySelector('.loading')) {
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading';
        loadingDiv.style.padding = '2rem';
        loadingDiv.textContent = 'Loading timetable...';
        app.appendChild(loadingDiv);
    }
    if (!document.getElementById('content')) {
        const contentDiv = document.createElement('div');
        contentDiv.id = 'content';
        app.appendChild(contentDiv);
    }

    const content = document.getElementById('content');

    // Load subject mapping first (best-effort)
    fetch('https://raw.githubusercontent.com/polarhive/attend/refs/heads/main/frontend/web/mapping.json')
        .then(response => response.json())
        .then(mappingData => {
            subjectMapping = mappingData.SUBJECT_MAPPING || {};
        })
        .catch(() => {
            subjectMapping = {};
        })
        .finally(() => {
            // Try to load from localStorage first
            const cachedData = localStorage.getItem('timetable.data');
            if (cachedData) {
                try {
                    const data = JSON.parse(cachedData);
                    window._lastTimetableData = data;
                    window._ownTimetableData = data;
                    const loading = document.querySelector('.loading');
                    if (loading) loading.style.display = 'none';
                    content.innerHTML = renderTimetable(data, comparisonData);
                    initPrefControls();
                    applyFilters();
                    return;
                } catch (e) {
                    console.error('Failed to parse cached timetable:', e);
                }
            }

            // If no cache or cache failed, fetch from API
            if (!userCredentials || !userCredentials.srn) {
                const loading = document.querySelector('.loading');
                if (loading) loading.innerHTML = 'Please login to view timetable.';
                return;
            }

            // Generate filename from SRN for direct timetable fetch
            const srn = userCredentials.srn;
            let filename = null;

            // Try to fetch the timetable by filename if we can derive it
            fetch('/api/timetable/all')
                .then(res => res.json())
                .then(allTimetables => {
                    // Find a matching timetable based on SRN prefix
                    const match = allTimetables.find(tt => {
                        const name = tt.name || '';
                        if (srn.startsWith('PES1') && name.startsWith('rr_')) return true;
                        if (srn.startsWith('PES2') && name.startsWith('ec_')) return true;
                        return false;
                    });
                    if (match) {
                        filename = match.name;
                        return fetch(`/api/timetable/${filename}`);
                    }
                    throw new Error('No matching timetable found');
                })
                .then(res => {
                    if (!res.ok) throw new Error('Failed to fetch timetable');
                    return res.json();
                })
                .then(data => {
                    // Save to localStorage
                    localStorage.setItem('timetable.data', JSON.stringify(data));
                    window._lastTimetableData = data;
                    window._ownTimetableData = data;
                    const loading = document.querySelector('.loading');
                    if (loading) loading.style.display = 'none';
                    content.innerHTML = renderTimetable(data, comparisonData);
                    initPrefControls();
                    applyFilters();
                })
                .catch(err => {
                    console.error('Error loading timetable:', err);
                    const loading = document.querySelector('.loading');
                    if (loading) loading.innerHTML = 'Error loading timetable. Please logout and login again.';
                });
        });
}