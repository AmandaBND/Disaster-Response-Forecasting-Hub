import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { 
    getFirestore, doc, addDoc, onSnapshot, collection, query, orderBy, serverTimestamp, 
    limit, updateDoc, arrayUnion, arrayRemove 
} from 'firebase/firestore';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line, ReferenceLine } from 'recharts';
import { Search, Globe, Droplet, Tent, Home, Wrench, AlertTriangle, MessageSquare, PlusCircle, Loader2 } from 'lucide-react';

// --- Global Constants and Firebase Setup (Phase 1, Step 1.2) ---
// These global variables are provided by the Canvas environment and MUST be used.
const appId = import.meta.env.VITE_APP_ID || 'default-app-id';
const firebaseConfig = JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG || '{}');
const initialAuthToken = import.meta.env.VITE_INITIAL_AUTH_TOKEN || null;

// LLM API Configuration
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=";
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || ""; // Managed by the environment

// --- Utility Functions (WAV/PCM conversion, currently unused but kept for audio expansion) ---
const base64ToArrayBuffer = (base64) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

// Function to convert PCM audio data to WAV format (Signed 16-bit PCM assumed)
const pcmToWav = (pcmData, sampleRate) => {
    const buffer = new ArrayBuffer(44 + pcmData.length * 2);
    const view = new DataView(buffer);
    let offset = 0;

    const writeString = (str) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset++, str.charCodeAt(i));
        }
    };

    const writeUint32 = (val) => {
        view.setUint32(offset, val, true);
        offset += 4;
    };

    const writeUint16 = (val) => {
        view.setUint16(offset, val, true);
        offset += 2;
    };

    // RIFF header
    writeString('RIFF');
    writeUint32(36 + pcmData.length * 2);
    writeString('WAVE');

    // FMT sub-chunk
    writeString('fmt ');
    writeUint32(16); // Sub-chunk size
    writeUint16(1); // Audio format (1 for PCM)
    writeUint16(1); // Num channels
    writeUint32(sampleRate); // Sample rate
    writeUint32(sampleRate * 2); // Byte rate (SampleRate * NumChannels * BitsPerSample/8)
    writeUint16(2); // Block align (NumChannels * BitsPerSample/8)
    writeUint16(16); // Bits per sample

    // Data sub-chunk
    writeString('data');
    writeUint32(pcmData.length * 2);

    // Write PCM data
    for (let i = 0; i < pcmData.length; i++) {
        view.setInt16(offset, pcmData[i], true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
};

// --- Agent Components ---

// 1. AI Query Agent (Phase 2: Intelligence Layer)
const AskGeminiAgent = ({ auth, userId }) => {
    const [query, setQuery] = useState('');
    const [response, setResponse] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    // Phase 2, Step 2.2: Implement Exponential Backoff and Grounding
    const handleQuery = async (e) => {
        e.preventDefault();
        if (!query.trim()) return;

        setIsLoading(true);
        setError(null);
        setResponse(null);

        // Phase 2, Step 2.3: Define System Prompt
        const systemPrompt = "You are a disaster information agent for Sri Lanka. Provide concise, grounded answers about current road/rail status, river water levels/flood status, affected areas, and local tourism status. Use the provided search results to verify your claims.";

        const payload = {
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
             role: "user",
             parts: [{ text: query }]
          }
         ]
        };


        try {
            let attempt = 0;
            let result = null;
            let finalResponse = null;
            const maxAttempts = 4;

            while (attempt < maxAttempts) { 
                if (attempt > 0) await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));

                const res = await fetch(GEMINI_API_URL + API_KEY, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (res.ok) {
                    finalResponse = await res.json();
                    result = finalResponse.candidates?.[0];
                    if (result && result.content?.parts?.[0]?.text) {
                        break; // Success
                    } else {
                        // Response OK but content missing, retry if not last attempt
                        if (attempt === maxAttempts - 1) throw new Error("API responded but returned empty content.");
                    }
                } else if (res.status === 429 && attempt < maxAttempts - 1) {
                    // Too many requests, continue loop to retry
                } else {
                    throw new Error(`API Request failed with status: ${res.status}`);
                }
                attempt++;
            }

            if (!result) throw new Error("Failed to get a response after multiple attempts.");

            const text = result.content.parts[0].text;
            let sources = [];
            const groundingMetadata = result.groundingMetadata;
            
            // Phase 2, Step 2.4: Extract Sources
            if (groundingMetadata && groundingMetadata.groundingAttributions) {
                sources = groundingMetadata.groundingAttributions
                    .map(attribution => ({
                        uri: attribution.web?.uri,
                        title: attribution.web?.title,
                    }))
                    .filter(source => source.uri && source.title);
            }

            setResponse({ text, sources });

        } catch (err) {
            console.error("Gemini API Error:", err);
            setError(`Could not fetch data. Please try again. (${err.message})`);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="w-full p-6 bg-white rounded-lg shadow-xl h-full flex flex-col">
            <h2 className="text-3xl font-bold text-gray-800 mb-2 flex items-center">
                <Search className="w-6 h-6 mr-2 text-indigo-500" /> Disaster Information Agent
            </h2>
            <p className="text-gray-500 mb-6">Ask about current road/rail status, river water levels, affected zones, or tourism updates. Powered by Gemini with Google Search.</p>
            
            <form onSubmit={handleQuery} className="flex space-x-3 mb-6">
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="E.g., What is the water level of the Kalu Ganga river? What is the status of Ella?"
                    className="flex-grow p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 transition duration-150 shadow-sm"
                    disabled={isLoading}
                />
                <button
                    type="submit"
                    className="flex items-center justify-center px-6 py-3 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 transition duration-150 disabled:bg-indigo-400 shadow-md"
                    disabled={isLoading}
                >
                    {isLoading ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                        <Globe className="w-5 h-5 mr-1" />
                    )}
                    {isLoading ? 'Searching...' : 'Ask'}
                </button>
            </form>

            <div className="flex-grow bg-gray-50 p-4 rounded-lg overflow-y-auto border border-gray-200">
                {error && (
                    <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative" role="alert">
                        <strong className="font-bold">Error: </strong>
                        <span className="block sm:inline">{error}</span>
                    </div>
                )}

                {response ? (
                    <>
                        <div className="text-gray-700 whitespace-pre-wrap leading-relaxed">
                            {response.text}
                        </div>
                        {response.sources.length > 0 && (
                            <div className="mt-4 pt-4 border-t border-gray-300">
                                <p className="font-semibold text-sm text-gray-600 mb-2">Sources:</p>
                                <ul className="list-disc list-inside space-y-1 text-sm text-indigo-600">
                                    {response.sources.map((source, index) => (
                                        <li key={index}>
                                            <a href={source.uri} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                                {source.title}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </>
                ) : !isLoading && !error && (
                    <p className="text-gray-400 text-center py-10">Your search results will appear here.</p>
                )}
            </div>
        </div>
    );
};

// 2. Public Health Forecasting Model (Phase 5: Scenario Analysis & Dual-Axis Visualization)
const ForecastingModel = () => {
    const [rainfallIncrease, setRainfallIncrease] = useState(0); // 0% to 50%
    const [temperatureIncrease, setTemperatureIncrease] = useState(0); // 0°C to 5°C
    const [populationDensity, setPopulationDensity] = useState(500); // Sample baseline

    // Phase 5, Step 5.1: Simulated SEIR / ML LOGIC using useMemo
    const baselineCases = 50; 
    const baselineResourcesPerCase = 3; 

    const forecastData = useMemo(() => {
        // Simple reactive formula to simulate ML/SEIR output:
        const rainfallFactor = 1 + (rainfallIncrease / 100) * 1.5;
        const temperatureFactor = 1 + (temperatureIncrease / 5) * 0.8;
        
        const combinedFactor = rainfallFactor * temperatureFactor; 
        
        const weeks = [1, 2, 3, 4];
        
        return weeks.map(w => {
            const cases = Math.round(baselineCases * combinedFactor * (1.2 ** w) * (populationDensity / 500));
            const resources = Math.round(cases * baselineResourcesPerCase);
            
            return {
                week: `Week ${w}`,
                'Predicted New Cases': cases,
                'Required Resources (Units)': resources,
            };
        });
    }, [rainfallIncrease, temperatureIncrease, populationDensity]);

    const handleRainfallChange = (e) => setRainfallIncrease(parseFloat(e.target.value));
    const handleTemperatureChange = (e) => setTemperatureIncrease(parseFloat(e.target.value));

    const totalPredictedCases = forecastData.reduce((sum, d) => sum + d['Predicted New Cases'], 0);
    const totalResourceUnits = forecastData.reduce((sum, d) => sum + d['Required Resources (Units)'], 0);

    return (
        <div className="w-full p-6 bg-white rounded-lg shadow-xl h-full flex flex-col">
            <h2 className="text-3xl font-bold text-gray-800 mb-2 flex items-center">
                <Droplet className="w-6 h-6 mr-2 text-red-600" /> Public Health Outbreak Forecast
            </h2>
            <p className="text-gray-500 mb-6">Scenario analysis for post-flood disease outbreaks (e.g., Dengue/Leptospirosis). This system predicts case counts and resource needs based on climate factors.</p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 p-4 bg-gray-50 rounded-lg shadow-inner">
                {/* Control 1: Rainfall Scenario */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 flex items-center mb-2">
                        <Droplet className="w-4 h-4 mr-1 text-blue-500" /> Rainfall Increase Scenario ({rainfallIncrease}%)
                    </label>
                    <input
                        type="range"
                        min="0"
                        max="50"
                        step="5"
                        value={rainfallIncrease}
                        onChange={handleRainfallChange}
                        className="w-full h-2 bg-blue-100 rounded-lg appearance-none cursor-pointer range-lg"
                    />
                    <p className="text-xs text-gray-500 mt-1">Simulates abnormal rainfall/flood persistence.</p>
                </div>
                {/* Control 2: Temperature Scenario */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 flex items-center mb-2">
                        <AlertTriangle className="w-4 h-4 mr-1 text-red-500" /> Temperature Anomaly (Base +{temperatureIncrease}°C)
                    </label>
                    <input
                        type="range"
                        min="0"
                        max="5"
                        step="0.5"
                        value={temperatureIncrease}
                        onChange={handleTemperatureChange}
                        className="w-full h-2 bg-red-100 rounded-lg appearance-none cursor-pointer range-lg"
                    />
                    <p className="text-xs text-gray-500 mt-1">Higher temps accelerate vector-borne disease cycles.</p>
                </div>
                 {/* Summary Card */}
                 <div className="p-3 bg-white border border-red-300 rounded-lg shadow-md">
                    <p className="text-sm font-semibold text-gray-600">4-Week Predicted Impact</p>
                    <p className="text-2xl font-bold text-red-600 mt-1">{totalPredictedCases.toLocaleString()}</p>
                    <p className="text-sm text-gray-500">Total Cases</p>
                    <p className="text-sm font-semibold text-gray-600 mt-3">Resource Demand</p>
                    <p className="text-xl font-bold text-indigo-600">{totalResourceUnits.toLocaleString()}</p>
                    <p className="text-xs text-gray-500">Total Units (Kits/Staff Hours)</p>
                </div>
            </div>

            <div className="flex-grow">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                        data={forecastData}
                        margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                    >
                        <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                        <XAxis dataKey="week" stroke="#374151" />
                        {/* Phase 5, Step 5.2: Dual Axis - Left for Cases */}
                        <YAxis yAxisId="left" orientation="left" stroke="#dc2626" />
                        {/* Phase 5, Step 5.2: Dual Axis - Right for Resources */}
                        <YAxis yAxisId="right" orientation="right" stroke="#4f46e5" /> 
                        <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} />
                        <Legend wrapperStyle={{ paddingTop: '10px' }} />
                        <Bar yAxisId="left" dataKey="Predicted New Cases" fill="#ef4444" radius={[4, 4, 0, 0]} />
                        <Bar yAxisId="right" dataKey="Required Resources (Units)" fill="#6366f1" radius={[4, 4, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};


// 3. Reconstruction Portal (Phase 3: Data Persistence)
const ReconstructionPortal = ({ db, auth, userId, isAuthReady }) => {
    const [properties, setProperties] = useState([]);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [newProperty, setNewProperty] = useState({
        name: '', description: '', location: '', type: 'Home', needed: 'Reconstruction', contact: ''
    });

    // Phase 3, Step 3.1: Real-time listener for public properties
    useEffect(() => {
        // Phase 3, Step 3.1: Guard Clause
        if (!isAuthReady || !db) return;

        const collectionPath = `/artifacts/${appId}/public/data/destroyed_properties`;
        const q = query(collection(db, collectionPath), orderBy('timestamp', 'desc'));

        // Phase 3, Step 3.1: onSnapshot listener
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const list = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setProperties(list);
        }, (error) => {
            console.error("Firestore listen failed:", error);
        });

        return () => unsubscribe();
    }, [db, isAuthReady]);

    const handleInputChange = (e) => {
        setNewProperty({ ...newProperty, [e.target.name]: e.target.value });
    };

    // Phase 3, Step 3.2: Submission Logic
    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!db || !userId) {
            console.error("Database not initialized or user not authenticated.");
            return;
        }
        if (!newProperty.name || !newProperty.description || !newProperty.location) {
             console.error("Please fill in all required fields.");
            return;
        }

        setIsSubmitting(true);
        try {
            const collectionPath = `/artifacts/${appId}/public/data/destroyed_properties`;
            await addDoc(collection(db, collectionPath), {
                ...newProperty,
                reporterId: userId,
                // Phase 3, Step 3.2: Metadata
                timestamp: serverTimestamp(),
            });
            setNewProperty({ name: '', description: '', location: '', type: 'Home', needed: 'Reconstruction', contact: '' });
        } catch (error) {
            console.error("Error adding document: ", error);
        } finally {
            setIsSubmitting(false);
        }
    };

    const PropertyCard = ({ property }) => (
        <div className="bg-white border border-gray-200 p-4 rounded-xl shadow-md transition duration-300 hover:shadow-lg flex flex-col">
            <div className="flex justify-between items-start mb-2">
                <div className='flex items-center'>
                    {property.type === 'Home' ? <Home className="w-5 h-5 text-indigo-500 mr-2" /> : <Wrench className="w-5 h-5 text-green-500 mr-2" />}
                    <h3 className="text-xl font-semibold text-gray-800">{property.name}</h3>
                </div>
                <span className={`px-3 py-1 text-xs font-medium rounded-full ${
                    property.needed === 'Reconstruction' ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'
                }`}>
                    {property.needed} Needed
                </span>
            </div>
            <p className="text-sm text-gray-600 mb-3 flex-grow">{property.description}</p>
            <div className="text-sm space-y-1 mt-auto">
                <p className="text-gray-700 font-medium flex items-center"><Globe className="w-4 h-4 mr-2 text-gray-400" />Location: {property.location}</p>
                <p className="text-gray-700 font-medium flex items-center"><MessageSquare className="w-4 h-4 mr-2 text-gray-400" />Contact Info: {property.contact || 'Not provided'}</p>
                <p className="text-xs text-gray-400 pt-2">Reported by: {property.reporterId} on {property.timestamp?.toDate().toLocaleDateString() || '...loading'}</p>
            </div>
        </div>
    );

    return (
        <div className="p-6 bg-white rounded-lg shadow-xl h-full flex flex-col">
            <h2 className="text-3xl font-bold text-gray-800 mb-2 flex items-center">
                <Tent className="w-6 h-6 mr-2 text-green-600" /> Reconstruction & Aid Portal
            </h2>
            <p className="text-gray-500 mb-6">List destroyed properties to connect with donors and construction teams. Data is public.</p>
            <div className="text-sm font-mono p-2 mb-4 bg-yellow-50 text-yellow-800 rounded-lg border border-yellow-200">
                Current User ID (Needed for coordination): <span className="font-bold">{userId || 'Loading...'}</span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-grow">
                {/* Submission Form */}
                <div className="lg:col-span-1 bg-gray-50 p-4 rounded-xl border border-gray-200 self-start sticky top-0">
                    <h3 className="text-xl font-semibold text-gray-700 mb-4 flex items-center"><PlusCircle className='w-5 h-5 mr-2'/> Add Property for Aid</h3>
                    <form onSubmit={handleSubmit} className="space-y-3">
                        <input type="text" name="name" value={newProperty.name} onChange={handleInputChange} placeholder="Property Name (e.g., My Home/The Corner Shop)" required className="w-full p-2 border border-gray-300 rounded-lg text-sm" />
                        <textarea name="description" value={newProperty.description} onChange={handleInputChange} placeholder="Detailed description of damage and aid needed..." rows="3" required className="w-full p-2 border border-gray-300 rounded-lg text-sm"></textarea>
                        <input type="text" name="location" value={newProperty.location} onChange={handleInputChange} placeholder="Location/Town/Village" required className="w-full p-2 border border-gray-300 rounded-lg text-sm" />
                        <input type="text" name="contact" value={newProperty.contact} onChange={handleInputChange} placeholder="Contact Details (Phone/Email)" className="w-full p-2 border border-gray-300 rounded-lg text-sm" />
                        
                        <div className='flex space-x-3'>
                            <select name="type" value={newProperty.type} onChange={handleInputChange} className="w-1/2 p-2 border border-gray-300 rounded-lg text-sm">
                                <option value="Home">Home/Residence</option>
                                <option value="Business">Small Business</option>
                            </select>
                            <select name="needed" value={newProperty.needed} onChange={handleInputChange} className="w-1/2 p-2 border border-gray-300 rounded-lg text-sm">
                                <option value="Reconstruction">Reconstruction</option>
                                <option value="Monetary">Monetary Donation</option>
                                <option value="Supplies">Supply Donation</option>
                            </select>
                        </div>

                        <button
                            type="submit"
                            className="w-full flex items-center justify-center px-4 py-2 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 transition duration-150 disabled:bg-green-400 shadow-md"
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <PlusCircle className="w-5 h-5 mr-2" />}
                            {isSubmitting ? 'Submitting...' : 'Submit Property for Aid'}
                        </button>
                    </form>
                </div>

                {/* Properties List */}
                <div className="lg:col-span-2 space-y-4 max-h-full overflow-y-auto">
                    <h3 className="text-xl font-semibold text-gray-700 mb-4">Properties Needing Aid ({properties.length})</h3>
                    {properties.length === 0 ? (
                        <p className="text-gray-400 text-center py-10">No properties listed yet. Be the first to add one!</p>
                    ) : (
                        properties.map(property => (
                            <PropertyCard key={property.id} property={property} />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};


// 4. Water Level Monitoring (Phase 4: Real-Time Simulation & Visualization)
const WaterLevelMonitor = () => {
    // Phase 4, Step 4.1: Define river constants
    const rivers = [
        { id: 'kalu', name: 'Kalu Ganga (Ratnapura)', major: 6.5, minor: 5.0, initial: 4.5, color: '#10b981' },
        { id: 'mahaweli', name: 'Mahaweli River (Peradeniya)', major: 10.0, minor: 8.5, initial: 7.0, color: '#3b82f6' },
        { id: 'kelani', name: 'Kelani River (Hanwella)', major: 7.8, minor: 6.5, initial: 6.0, color: '#f59e0b' },
    ];

    const [realTimeData, setRealTimeData] = useState([]);

    // Phase 4, Step 4.1: Simulation Engine
    useEffect(() => {
        const initialData = rivers.map(r => ({
            name: r.name,
            current: r.initial,
            minor: r.minor,
            major: r.major
        }));

        setRealTimeData(initialData);

        const intervalId = setInterval(() => {
            setRealTimeData(prevData => prevData.map(riverData => {
                // Simulate fluctuation
                const fluctuation = (Math.random() - 0.45) * 0.2; 
                let newLevel = riverData.current + fluctuation;

                newLevel = Math.max(3.0, Math.min(11.0, newLevel));
                
                return {
                    ...riverData,
                    current: parseFloat(newLevel.toFixed(2)),
                };
            }));
        }, 3000); // Update every 3 seconds

        return () => clearInterval(intervalId); // Cleanup
    }, []);

    const combinedChartData = useMemo(() => {
        if (realTimeData.length === 0) return [];
        
        return realTimeData.map(r => ({
            name: r.name.split('(')[0].trim(), 
            Current_Level_m: r.current,
            Minor_Threshold: r.minor,
            Major_Threshold: r.major,
            status: r.current > r.major ? 'Major Flood' : (r.current > r.minor ? 'Minor Flood' : 'Normal')
        }));
    }, [realTimeData]);

    // Phase 4, Step 4.2: Alert Logic and UI
    const RiverStatusCard = ({ river }) => {
        const dataPoint = combinedChartData.find(d => d.name === river.name.split('(')[0].trim());
        if (!dataPoint) return null;

        let statusClass = 'bg-green-100 text-green-800 border-green-300';
        let statusText = 'Normal';
        let icon = <Droplet className="w-5 h-5 text-green-500" />;

        // Phase 4, Step 4.2: Conditional Logic
        if (dataPoint.Current_Level_m > dataPoint.Major_Threshold) {
            statusClass = 'bg-red-100 text-red-800 border-red-300';
            statusText = 'Major Flood Alert';
            icon = <AlertTriangle className="w-5 h-5 text-red-500" />;
        } else if (dataPoint.Current_Level_m > dataPoint.Minor_Threshold) {
            statusClass = 'bg-yellow-100 text-yellow-800 border-yellow-300';
            statusText = 'Minor Flood Alert';
            icon = <AlertTriangle className="w-5 h-5 text-yellow-500" />;
        }

        return (
            <div className="p-4 rounded-xl shadow-lg bg-white border border-gray-200">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="text-lg font-semibold text-gray-800">{river.name}</h3>
                    <div className="flex items-center space-x-2">
                        {icon}
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusClass}`}>
                            {statusText}
                        </span>
                    </div>
                </div>
                <div className="text-3xl font-bold mb-1" style={{ color: river.color }}>
                    {dataPoint.Current_Level_m} <span className="text-base font-normal text-gray-500">m</span>
                </div>
                <div className="text-sm text-gray-600 space-y-1">
                    <p>Minor Flood Threshold: <span className="font-medium text-yellow-600">{river.minor} m</span></p>
                    <p>Major Flood Threshold: <span className="font-medium text-red-600">{river.major} m</span></p>
                </div>
            </div>
        );
    };


    return (
        <div className="w-full p-6 bg-white rounded-lg shadow-xl h-full flex flex-col">
            <h2 className="text-3xl font-bold text-gray-800 mb-2 flex items-center">
                <Droplet className="w-6 h-6 mr-2 text-blue-600" /> Real-Time Water Monitoring (Simulated)
            </h2>
            <p className="text-gray-500 mb-6">Simulated current water levels and flood status for key river basins in Sri Lanka. Levels update every 3 seconds.</p>

            <div className='grid grid-cols-1 md:grid-cols-3 gap-6 mb-6'>
                {rivers.map(r => <RiverStatusCard key={r.id} river={r} />)}
            </div>

            <div className="flex-grow border border-gray-200 rounded-lg p-2 bg-gray-50">
                <h3 className="text-lg font-semibold text-gray-700 mb-2">Current Water Level Comparison</h3>
                <ResponsiveContainer width="100%" height="90%">
                    <BarChart
                        data={combinedChartData}
                        margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                        barCategoryGap="20%"
                    >
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e0e0e0" />
                        <XAxis dataKey="name" stroke="#374151" />
                        <YAxis stroke="#4b5563" label={{ value: 'Water Level (m)', angle: -90, position: 'insideLeft' }} domain={[0, 12]}/>
                        <Tooltip 
                            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} 
                            formatter={(value, name, props) => {
                                if (name === 'Current_Level_m') return [value.toFixed(2) + ' m', 'Current Level'];
                                return [value + ' m', name];
                            }}
                        />
                        <Legend wrapperStyle={{ paddingTop: '10px' }} />
                        
                        {/* Phase 4, Step 4.3: Reference Lines for context */}
                        <ReferenceLine y={rivers[0].major} label={{ value: 'Major Flood (Kalu Ganga)', position: 'insideTopRight', fill: '#ef4444', fontSize: 10 }} stroke="#ef4444" strokeDasharray="5 5" />
                        <ReferenceLine y={rivers[0].minor} label={{ value: 'Minor Flood (Kalu Ganga)', position: 'insideTopLeft', fill: '#f59e0b', fontSize: 10 }} stroke="#f59e0b" strokeDasharray="5 5" />

                        {/* Current Level Bar */}
                        <Bar 
                            dataKey="Current_Level_m" 
                            name="Current Level"
                            fill="#3b82f6" 
                            radius={[4, 4, 0, 0]}
                        />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};


// 5. Main App Component (Phase 1: Project Setup and Foundational Services)
const App = () => {
    const [currentPage, setCurrentPage] = useState('AskGemini');
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    // Phase 1, Step 1.3: Firebase Initialization and Authentication Logic
    useEffect(() => {
        if (Object.keys(firebaseConfig).length === 0) {
            console.error("Firebase config is missing. Cannot initialize Firestore.");
            return;
        }

        try {
            // Phase 1, Step 1.3: Initialize Firebase
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const firebaseAuth = getAuth(app);
            setDb(firestore);
            setAuth(firebaseAuth);

            // Phase 1, Step 1.3: Authentication Listener
            const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
                if (user) {
                    setUserId(user.uid);
                } else {
                    // Fallback to anonymous sign-in if token is not available
                    if (!initialAuthToken) {
                        signInAnonymously(firebaseAuth)
                            .then(cred => setUserId(cred.user.uid))
                            .catch(e => console.error("Anonymous sign-in failed:", e));
                    }
                }
                // Phase 1, Step 1.3: Set Auth Ready
                setIsAuthReady(true);
            });

            // Initial sign-in attempt
            if (initialAuthToken) {
                signInWithCustomToken(firebaseAuth, initialAuthToken)
                    .then(cred => setUserId(cred.user.uid))
                    .catch(e => {
                        console.error("Custom token sign-in failed:", e);
                        // Mandatory fallback
                        signInAnonymously(firebaseAuth)
                            .then(cred => setUserId(cred.user.uid))
                            .catch(e => console.error("Anonymous sign-in failed on fallback:", e));
                    });
            } else if (!auth?.currentUser) {
                 // Fallback if no token is provided initially
                 signInAnonymously(firebaseAuth)
                    .then(cred => setUserId(cred.user.uid))
                    .catch(e => console.error("Anonymous sign-in failed:", e));
            }


            return () => unsubscribe();
        } catch (e) {
            console.error("Firebase initialization error:", e);
        }
    }, []);


    // Phase 1, Step 1.4: Conditional Component Rendering
    const renderPage = () => {
        switch (currentPage) {
            case 'AskGemini':
                return <AskGeminiAgent auth={auth} userId={userId} />;
            case 'WaterMonitor':
                return <WaterLevelMonitor />;
            case 'Forecasting':
                return <ForecastingModel />;
            case 'Donations':
                return <ReconstructionPortal db={db} auth={auth} userId={userId} isAuthReady={isAuthReady} />;
            default:
                return <AskGeminiAgent auth={auth} userId={userId} />;
        }
    };

    // Phase 1, Step 1.4: Navigation Items
    const navItems = [
        { id: 'AskGemini', icon: Search, label: 'AI Query Agent' },
        { id: 'WaterMonitor', icon: Droplet, label: 'Water Monitoring' }, 
        { id: 'Forecasting', icon: AlertTriangle, label: 'Health Forecast' },
        { id: 'Donations', icon: Tent, label: 'Reconstruction Portal' },
    ];

    return (
  <div 
  className="min-h-screen font-sans bg-cover bg-no-repeat bg-center"
  style={{ backgroundImage: "url('/bg.webp')" }}
>

    <div className="mx-auto max-w-7xl px-4 py-10">   {/* <-- This fixes the empty right space */}

      {/* HEADER */}
      <header className="mb-6 flex items-center space-x-4">
  <img 
    src="/bgflood.png" 
    alt="Ella Landscape" 
    className="w-40 h-40 object-cover rounded-lg shadow-md"
  />

  <div>
    <h1 className="text-5xl font-extrabold text-indigo-700">
      Disaster Resilience Hub
    </h1>
    <p className="text-gray-500">
      Intelligent coordination and public information for recovery.
    </p>
  </div>
</header>

      {/* NAVIGATION TABS */}
      <nav className="flex space-x-2 border-b border-gray-300 mb-6 overflow-x-auto">
        {navItems.map(item => (
          <button
            key={item.id}
            onClick={() => setCurrentPage(item.id)}
            className={`flex items-center px-4 py-2 text-sm font-medium rounded-t-lg transition duration-200
              ${
                currentPage === item.id
                  ? 'bg-white text-indigo-600 border-t border-x border-gray-300'
                  : 'text-gray-500 hover:bg-gray-200'
              }`}
          >
            <item.icon className="w-5 h-5 mr-2" />
            {item.label}
          </button>
        ))}
      </nav>

      {/* MAIN CONTENT */}
      <div className="min-h-[70vh]">
        {renderPage()}
      </div>

    </div>
  </div>
);

};

export default App;